import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import type { AiApi } from "../../types";

const startSchema = z.object({ project: z.string().min(1).nullable() });
const questionSchema = z.object({ question: z.string().min(1) });

export function createAiRouter(api: AiApi): express.Router {
  const router = express.Router();

  router.get("/api/ai/categories", (_req, res) => {
    res.json({ categories: api.listCategories() });
  });

  router.post("/api/ai/conversations", async (req, res, next) => {
    try {
      const { project } = startSchema.parse(req.body);
      if (project && !api.listCategories().some((c) => c.name === project)) {
        res.status(400).json({ error: `Unknown project "${project}"` });
        return;
      }
      const conversation = await api.startConversation(project, req.user!);
      res.status(201).json({ conversation });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/ai/conversations", async (req, res, next) => {
    try {
      const conversations = await api.listConversations(req.user!, isAdmin(req.user!));
      res.json({ conversations });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/ai/conversations/:id/jobs", async (req, res, next) => {
    try {
      const { question } = questionSchema.parse(req.body);
      const job = await api.submitQuestion(req.params.id, question, req.user!);
      res.status(201).json({ job });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/ai/conversations/:id/jobs", async (req, res, next) => {
    try {
      const jobs = await api.listJobs(req.params.id, req.user!, isAdmin(req.user!));
      res.json({ jobs });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/ai/jobs/:id/cancel", async (req, res, next) => {
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

  router.get("/api/ai/jobs/:id", async (req, res, next) => {
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
