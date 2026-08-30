import { createWriteStream } from "fs";
import { stat } from "fs/promises";
import { join } from "path";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import { config } from "../../config";
import { createNamedTmpDir, removeTmpDir, tmpDirByName } from "../../tmp";
import { ARTIFACTORY_SCENARIOS } from "./devSimulation";
import type { ArtifactoryApi, ArtifactoryScenario } from "../../types";

const urlCopySchema = z.object({
  sourceUrl: z.string().url(),
  includeDependencies: z.boolean().optional(),
});

/**
 * 500 MB, matching the whitening module — a zipped node_modules is sizeable
 * even compressed. Enforced as the archive lands, so a folder that runs over is
 * stopped mid-upload rather than after the client has sent all of it.
 */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

/**
 * `art-<uuid>`, exactly as `createNamedTmpDir` mints it, and nothing else: this
 * string is turned into a directory path, so it is checked before it is joined
 * rather than sanitised afterwards.
 */
const UPLOAD_ID = /^art-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ARCHIVE_NAME = "upload.zip";

/** Thrown by `byteLimit`, so the route can tell a too-large part from a dead socket. */
export class UploadTooLargeError extends Error {}

/**
 * Fail a stream once more than `max` bytes have passed through it, counting from
 * `already`. It has to be a stream in the pipeline rather than a `data` listener
 * on the request: destroying the request from a listener can still let
 * `pipeline` resolve, and the part is then answered "200 OK" and left on disk.
 */
export function byteLimit(max: number, already = 0): Transform {
  let total = already;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total <= max) return done(null, chunk);
      done(new UploadTooLargeError(`Over ${max} bytes`));
    },
  });
}

const folderUploadSchema = z.object({
  uploadId: z.string().regex(UPLOAD_ID),
  folderName: z.string().trim().min(1),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

export function createArtifactoryRouter(api: ArtifactoryApi): express.Router {
  const router = express.Router();

  router.post("/api/artifactory/jobs/url-copy", async (req, res, next) => {
    try {
      const input = urlCopySchema.parse(req.body);
      const job = await api.submitUrlCopy(input, req.user!);
      res.status(201).json({ job });
    } catch (err) {
      next(err);
    }
  });

  /**
   * The three halves of a folder upload. The client zips and sends at the same
   * time — a part goes out while the next files are still being compressed —
   * because the two used to run one after the other and the user waited for the
   * sum. Parts are appended in order to one file in a temp dir named by the id
   * handed out here; `jobs/folder-upload` then hands that file to the job
   * exactly as the single multipart POST used to.
   */
  router.post("/api/artifactory/uploads", async (_req, res, next) => {
    try {
      res.status(201).json({ uploadId: await createNamedTmpDir("art-") });
    } catch (err) {
      next(err);
    }
  });

  router.put("/api/artifactory/uploads/:uploadId", async (req, res, next) => {
    const { uploadId } = req.params;
    if (!UPLOAD_ID.test(uploadId)) {
      res.status(400).json({ error: "Malformed upload id" });
      return;
    }

    const dir = tmpDirByName(uploadId);
    const archivePath = join(dir, ARCHIVE_NAME);

    try {
      if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) {
        res.status(404).json({ error: "Unknown or expired upload" });
        return;
      }

      // Parts are appended, so one arriving out of order would splice itself
      // into the middle of the archive and only show up as a corrupt zip
      // minutes later. The client says where it thinks it is; the file says
      // where it actually is, and a mismatch is refused rather than written.
      const written = await stat(archivePath).then((s) => s.size, () => 0);
      if (Number(req.query.offset) !== written) {
        res.status(409).json({ error: `Upload is at ${written} bytes, not ${req.query.offset}` });
        return;
      }

      // Counted as it streams, so a folder that runs over is stopped partway
      // rather than after the client has sent all of it.
      const out = createWriteStream(archivePath, { flags: "a" });
      await pipeline(req, byteLimit(MAX_ARCHIVE_BYTES, written), out);

      res.json({ bytes: written + out.bytesWritten });
    } catch (err) {
      await removeTmpDir(dir);
      if (err instanceof UploadTooLargeError) {
        res.status(413).json({ error: "Upload is too large — the limit is 500 MB." });
        return;
      }
      next(err);
    }
  });

  router.post("/api/artifactory/jobs/folder-upload", async (req, res, next) => {
    // The job takes ownership of the upload's dir on success; every path that
    // does not reach it has to drop the dir itself, or a 500 MB archive sits on
    // disk until the 24h sweep.
    let dir: string | undefined;
    try {
      const input = folderUploadSchema.parse(req.body);
      dir = tmpDirByName(input.uploadId);
      const archivePath = join(dir, ARCHIVE_NAME);

      if (!(await stat(archivePath).then((s) => s.size > 0, () => false))) {
        await removeTmpDir(dir);
        res.status(400).json({ error: "No archive was uploaded" });
        return;
      }

      const job = await api.submitFolderUpload(
        {
          folderName: input.folderName,
          fileCount: input.fileCount,
          totalBytes: input.totalBytes,
          archivePath,
        },
        req.user!
      );
      res.status(201).json({ job });
    } catch (err) {
      if (dir) await removeTmpDir(dir);
      next(err);
    }
  });

  // Dev only — the Test button. Never mounted behind an SSO proxy.
  if (!config.ssoRequired) {
    router.post("/api/artifactory/jobs/simulate", async (req, res, next) => {
      try {
        const requested = req.body?.scenario as ArtifactoryScenario | undefined;
        const scenario = ARTIFACTORY_SCENARIOS.includes(requested!) ? requested : undefined;
        res.status(201).json({ job: await api.simulate(req.user!, scenario) });
      } catch (err) {
        next(err);
      }
    });
  }

  router.post("/api/artifactory/jobs/:id/cancel", async (req, res, next) => {
    try {
      const job = await api.cancelJob(req.params.id, req.user!, isAdmin(req.user!));
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json({ job });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/artifactory/jobs", async (req, res, next) => {
    try {
      const jobs = await api.listJobs(req.user!, isAdmin(req.user!));
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/artifactory/jobs/:id", async (req, res, next) => {
    try {
      const job = await api.getJob(req.params.id);
      if (!job) throw new Error("Job not found");
      res.json({ job });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
