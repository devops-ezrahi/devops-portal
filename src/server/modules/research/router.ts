import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import type { ResearchApi } from "../../types";

const startSchema = z.object({ project: z.string().min(1) });
const questionSchema = z.object({ question: z.string().min(1) });

export function createResearchRouter(api: ResearchApi): express.Router {
  const router = express.Router();

  router.get("/api/research/categories", (_req, res) => {
    res.json({ categories: api.listCategories() });
  });

  router.post("/api/research/conversations", async (req, res, next) => {
    try {
      const { project } = startSchema.parse(req.body);
      if (!api.listCategories().some((c) => c.name === project)) {
        res.status(400).json({ error: `Unknown project "${project}"` });
        return;
      }
      const conversation = await api.startConversation(project, req.user!);
      res.status(201).json({ conversation });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/research/conversations", async (req, res, next) => {
    try {
      const conversations = await api.listConversations(req.user!, isAdmin(req.user!));
      res.json({ conversations });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/research/conversations/:id/jobs", async (req, res, next) => {
    try {
      const { question } = questionSchema.parse(req.body);
      const job = await api.submitQuestion(req.params.id, question, req.user!);
      res.status(201).json({ job });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/research/conversations/:id/jobs", async (req, res, next) => {
    try {
      const jobs = await api.listJobs(req.params.id, req.user!, isAdmin(req.user!));
      res.json({ jobs });
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
