import express from "express";
import multer from "multer";
import { isAdmin } from "../../auth";
import type { WhiteningApi } from "../../types";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB — packs include dependencies + image tars
});

const ARCHIVE_NAME = /\.(tgz|tar\.gz)$/i;

export function createWhiteningRouter(api: WhiteningApi): express.Router {
  const router = express.Router();

  router.post("/api/whitening/jobs", upload.single("file"), async (req, res, next) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: "file is required" });
        return;
      }
      if (!ARCHIVE_NAME.test(file.originalname)) {
        res.status(400).json({ error: "file must be a .tgz" });
        return;
      }
      let job;
      try {
        job = await api.submitUnpack(file.buffer, file.originalname, req.user!);
      } catch (err) {
        // submitUnpack only rejects on an unreadable archive / bad config.json.
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      res.status(201).json({ job });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/whitening/jobs", async (req, res, next) => {
    try {
      const jobs = await api.listJobs(req.user!, isAdmin(req.user!));
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/whitening/jobs/:id", async (req, res, next) => {
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
