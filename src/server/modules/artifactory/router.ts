import express from "express";
import multer from "multer";
import { z } from "zod";
import { isAdmin } from "../../auth";
import type { ArtifactoryApi, FolderUploadInput } from "../../types";

const urlCopySchema = z.object({
  sourceUrl: z.string().url(),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB per file
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
    upload.array("files"),
    async (req, res, next) => {
      try {
        const folderName = String(req.body.folderName ?? "").trim();
        if (!folderName) {
          res.status(400).json({ error: "folderName is required" });
          return;
        }

        const multerFiles = (req.files as Express.Multer.File[]) ?? [];
        const files = multerFiles.map((f) => ({
          originalname: f.originalname,
          mimetype: f.mimetype,
          buffer: f.buffer,
        }));

        const fileCount = files.length || Number(req.body.fileCount ?? 0);
        const totalBytes =
          files.reduce((sum, f) => sum + f.buffer.length, 0) ||
          Number(req.body.totalBytes ?? 0);

        const input: FolderUploadInput = {
          folderName,
          fileCount,
          totalBytes,
          files: files.length > 0 ? files : undefined,
        };

        const job = await api.submitFolderUpload(input, req.user!);
        res.status(201).json({ job });
      } catch (err) {
        next(err);
      }
    }
  );

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
