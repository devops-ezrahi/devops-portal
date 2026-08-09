import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import type { ResearchApi } from "../../types";

const submitSchema = z.object({
  project: z.string().min(1),
  question: z.string().min(1),
});

export function createResearchRouter(api: ResearchApi): express.Router {
  const router = express.Router();

  router.get("/api/research/projects", (_req, res) => {
    res.json({ projects: api.listProjects() });
  });

  router.post("/api/research/jobs", async (req, res, next) => {
    try {
      const { project, question } = submitSchema.parse(req.body);
      if (!api.listProjects().includes(project)) {
        res.status(400).json({ error: `Unknown project "${project}" — not in RESEARCH_PROJECTS` });
        return;
      }
      const job = await api.submitQuestion(project, question, req.user!);
      res.status(201).json({ job });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/research/jobs/:id/cancel", async (req, res, next) => {
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

  router.get("/api/research/jobs", async (req, res, next) => {
    try {
      const jobs = await api.listJobs(req.user!, isAdmin(req.user!));
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/research/jobs/:id", async (req, res, next) => {
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
