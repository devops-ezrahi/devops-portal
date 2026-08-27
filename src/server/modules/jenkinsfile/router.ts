import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import { log } from "../../log";
import { PipelineStore } from "./PipelineStore";
import type { JenkinsfilePipeline } from "../../types";

/**
 * The body the builder sends. `args` stays `unknown` on purpose: the shape of a
 * stage's arguments is the shared library's business, described by the client's
 * catalog, and pinning it here would mean editing the server every time the
 * library grows a key.
 */
const pipelineBody = z.object({
  name: z.string().trim().min(1).max(120),
  library: z.string().trim().min(1).max(200),
  envVars: z.record(z.string(), z.string()),
  stages: z
    .array(
      z.object({
        id: z.string().min(1),
        step: z.string().min(1),
        args: z.record(z.string(), z.unknown()),
      })
    )
    .max(100),
});

export function createJenkinsfileRouter(store: PipelineStore = new PipelineStore()): express.Router {
  const router = express.Router();

  /** Owner or admin. Anything else is a 403 the app-level handler maps from the message. */
  function mine(pipeline: JenkinsfilePipeline, req: express.Request): boolean {
    return pipeline.createdBy === req.user!.id || isAdmin(req.user!);
  }

  router.get("/api/jenkinsfile/pipelines", (req, res) => {
    const all = store.all();
    res.json({ pipelines: isAdmin(req.user!) ? all : all.filter((p) => p.createdBy === req.user!.id) });
  });

  router.post("/api/jenkinsfile/pipelines", async (req, res, next) => {
    try {
      const body = pipelineBody.parse(req.body);
      const now = new Date().toISOString();
      const pipeline = await store.put({
        ...body,
        id: store.nextId(),
        createdBy: req.user!.id,
        createdByName: req.user!.displayName,
        createdAt: now,
        updatedAt: now,
      });
      log.info("jenkinsfile", `created ${pipeline.id}`, { name: pipeline.name, stages: pipeline.stages.length });
      res.status(201).json({ pipeline });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/jenkinsfile/pipelines/:id", (req, res) => {
    const pipeline = store.get(req.params.id);
    if (!pipeline) {
      res.status(404).json({ error: "Pipeline not found" });
      return;
    }
    if (!mine(pipeline, req)) {
      res.status(403).json({ error: "Forbidden — that pipeline belongs to someone else" });
      return;
    }
    res.json({ pipeline });
  });

  router.put("/api/jenkinsfile/pipelines/:id", async (req, res, next) => {
    try {
      const existing = store.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Pipeline not found" });
        return;
      }
      if (!mine(existing, req)) {
        res.status(403).json({ error: "Forbidden — that pipeline belongs to someone else" });
        return;
      }
      const body = pipelineBody.parse(req.body);
      // Ownership and creation time are the record's, not the request's — an
      // admin editing someone else's pipeline must not take it over.
      const pipeline = await store.put({ ...existing, ...body, updatedAt: new Date().toISOString() });
      log.info("jenkinsfile", `updated ${pipeline.id}`, { name: pipeline.name, stages: pipeline.stages.length });
      res.json({ pipeline });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api/jenkinsfile/pipelines/:id", async (req, res, next) => {
    try {
      const existing = store.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Pipeline not found" });
        return;
      }
      if (!mine(existing, req)) {
        res.status(403).json({ error: "Forbidden — that pipeline belongs to someone else" });
        return;
      }
      await store.remove(existing.id);
      log.info("jenkinsfile", `deleted ${existing.id}`, { name: existing.name });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
