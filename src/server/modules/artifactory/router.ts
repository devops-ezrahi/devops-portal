import { dirname } from "path";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { isAdmin } from "../../auth";
import { config } from "../../config";
import { createTmpDir, removeTmpDir } from "../../tmp";
import { ARTIFACTORY_SCENARIOS } from "./devSimulation";
import type { ArtifactoryApi, ArtifactoryScenario } from "../../types";

const urlCopySchema = z.object({
  sourceUrl: z.string().url(),
});

/**
 * 500 MB, matching the whitening module — a zipped node_modules is sizeable
 * even compressed. The client checks the same number before spending minutes
 * zipping a folder it cannot send (`MAX_ARCHIVE_BYTES` in FolderUploadForm).
 */
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;

const upload = multer({
  // Straight to disk. `memoryStorage` held the whole archive in the heap and
  // then wrote a second copy out — two full-size copies of a 500 MB upload,
  // pinned for as long as the job ran. Each request gets its own `art-` dir,
  // which the boot-time temp sweeper already covers if a crash orphans one.
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      createTmpDir("art-").then((dir) => cb(null, dir), (err: Error) => cb(err, ""));
    },
    filename: (_req, _file, cb) => cb(null, "upload.zip"),
  }),
  limits: { fileSize: MAX_ARCHIVE_BYTES, files: 1 },
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

  router.post(
    "/api/artifactory/jobs/folder-upload",
    upload.single("archive"),
    async (req, res, next) => {
      // The job takes ownership of multer's temp dir on success; every path
      // that does not reach it has to drop the dir itself, or a 500 MB archive
      // sits on disk until the 24h sweep.
      const archivePath = req.file?.path;
      try {
        const folderName = String(req.body.folderName ?? "").trim();
        if (!folderName || !archivePath) {
          if (archivePath) await removeTmpDir(dirname(archivePath));
          res.status(400).json({ error: !folderName ? "folderName is required" : "archive is required" });
          return;
        }

        const job = await api.submitFolderUpload(
          {
            folderName,
            fileCount: Number(req.body.fileCount ?? 0),
            totalBytes: Number(req.body.totalBytes ?? 0),
            archivePath,
          },
          req.user!
        );
        res.status(201).json({ job });
      } catch (err) {
        if (archivePath) await removeTmpDir(dirname(archivePath));
        next(err);
      }
    }
  );

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
