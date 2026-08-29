import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import { config } from "../../config";
import { log } from "../../log";
import { pickableImages } from "./images";
import { PipelineStore } from "./PipelineStore";
import type { JenkinsfilePipeline } from "../../types";

/**
 * The body the builder sends. `args` stays `unknown` on purpose: the shape of a
 * stage's arguments is the shared library's business, described by the client's
 * catalog, and pinning it here would mean editing the server every time the
 * library grows a key.
 */
const pipelineBody = z.object({
  // Optional, and blank means "leave the name alone": the server still mints
  // one on create, so a pipeline always has a name even if nothing is typed.
  name: z.string().trim().max(80).optional(),
  // Empty is legal: the @Library line is optional, and the builder only ever
  // sends the configured name (optionally `@branch`) or nothing at all.
  library: z.string().trim().max(200),
  envVars: z.record(z.string(), z.string()),
  params: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        type: z.enum(["boolean", "string", "choice"]).default("boolean"),
        // Records written when every parameter was a booleanParam hold a real
        // boolean here; one shape on the way in beats a migration on the way out.
        defaultValue: z.union([z.string(), z.boolean()]).transform(String).default(""),
        description: z.string().max(300),
        choices: z.array(z.string()).max(50).optional(),
      })
    )
    .max(50)
    .default([]),
  stages: z
    .array(
      z.object({
        id: z.string().min(1),
        step: z.string().min(1),
        args: z.record(z.string(), z.unknown()),
        collapsed: z.boolean().optional(),
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

  /**
   * The name a pipeline starts with — whoever made it plus their own running
   * count, so the list reads "Alex Morgan #3". The count is per author and
   * derived from what they already own, so two people never collide and
   * deleting #2 lets the next one reuse the number.
   *
   * It is only a starting point: the builder shows the name and can change it.
   * Minting still matters because a pipeline is saved the moment it has a
   * stage, long before anyone thinks to name it.
   */
  function mintName(req: express.Request): string {
    const owner = req.user!;
    const taken = new Set(
      store
        .all()
        .filter((p) => p.createdBy === owner.id)
        .map((p) => p.name)
    );
    const label = owner.displayName?.trim() || owner.id;
    for (let n = 1; ; n++) {
      const candidate = `${label} #${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  router.get("/api/jenkinsfile/pipelines", (req, res) => {
    const all = store.all();
    res.json({
      pipelines: isAdmin(req.user!) ? all : all.filter((p) => p.createdBy === req.user!.id),
      // Rides along on the list the view already fetches, rather than a second
      // endpoint or a field on the public /api/config.
      sharedLibrary: config.jenkinsfile.sharedLibrary,
    });
  });

  /**
   * Deliberately not ridden along on the pipelines list next to
   * `sharedLibrary`: that is a static config string, this is a network call,
   * and an Artifactory hiccup must not be able to take out the pipeline list.
   */
  router.get("/api/jenkinsfile/images", async (_req, res) => {
    res.json({ images: await pickableImages() });
  });

  router.post("/api/jenkinsfile/pipelines", async (req, res, next) => {
    try {
      const body = pipelineBody.parse(req.body);
      const now = new Date().toISOString();
      const pipeline = await store.put({
        ...body,
        name: body.name?.trim() || mintName(req),
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
      // A blank name keeps the stored one rather than emptying the list row.
      const pipeline = await store.put({
        ...existing,
        ...body,
        name: body.name?.trim() || existing.name,
        updatedAt: new Date().toISOString(),
      });
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
