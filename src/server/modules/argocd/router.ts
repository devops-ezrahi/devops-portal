import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import { config } from "../../config";
import { log } from "../../log";
import { TreeStore } from "./TreeStore";
import type { ArgocdTree } from "../../types";

/**
 * The body the builder sends. Feature values stay `unknown`: their shape is the
 * chart's business, described by the client's catalog, and pinning it here
 * would mean editing the server every time `values.yaml` grows a key — the same
 * call the Jenkinsfile router makes for a stage's `args`.
 */
const featureState = z.object({ on: z.boolean(), v: z.record(z.string(), z.unknown()) });

const treeBody = z.object({
  // Optional, and blank means "leave the name alone": the server still mints
  // one on create, so a tree always has a name even if nothing is typed.
  name: z.string().trim().max(80).optional(),
  chart: z.object({
    repoUrl: z.string().trim().max(300),
    path: z.string().trim().max(200),
    revision: z.string().trim().max(100),
  }),
  values: z.object({
    repoUrl: z.string().trim().max(300),
    revision: z.string().trim().max(100),
    path: z.string().trim().max(200),
  }),
  rootAppName: z.string().trim().max(80),
  releases: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().trim().max(80),
        features: z.record(z.string(), featureState),
        extraValues: z.string().max(100_000).optional(),
      })
    )
    .max(200),
  namespaces: z
    .array(
      z.object({
        name: z.string().trim().max(80),
        releases: z
          .array(
            z.object({
              release: z.string().min(1),
              features: z.record(z.string(), featureState),
              extraValues: z.string().max(100_000).optional(),
            })
          )
          .max(200),
      })
    )
    .max(50),
});

export function createArgocdRouter(store: TreeStore = new TreeStore()): express.Router {
  const router = express.Router();

  /** Owner or admin. Anything else is a 403. */
  function mine(tree: ArgocdTree, req: express.Request): boolean {
    return tree.createdBy === req.user!.id || isAdmin(req.user!);
  }

  /**
   * The name a tree starts with — whoever made it plus their own running count.
   * Per author and derived from what they already own, so two people never
   * collide and deleting #2 lets the next one reuse the number. It is only a
   * starting point: the builder shows the name and can change it.
   */
  function mintName(req: express.Request): string {
    const owner = req.user!;
    const taken = new Set(
      store
        .all()
        .filter((t) => t.createdBy === owner.id)
        .map((t) => t.name)
    );
    const label = owner.displayName?.trim() || owner.id;
    for (let n = 1; ; n++) {
      const candidate = `${label} #${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  router.get("/api/argocd/trees", (req, res) => {
    const all = store.all();
    res.json({
      trees: isAdmin(req.user!) ? all : all.filter((t) => t.createdBy === req.user!.id),
      // Rides along on the list the view already fetches, rather than a second
      // endpoint — these only pre-fill a new tree, they do not constrain one.
      defaults: config.argocd,
    });
  });

  router.post("/api/argocd/trees", async (req, res, next) => {
    try {
      const body = treeBody.parse(req.body);
      const now = new Date().toISOString();
      const tree = await store.put({
        ...body,
        name: body.name?.trim() || mintName(req),
        id: store.nextId(),
        createdBy: req.user!.id,
        createdByName: req.user!.displayName,
        createdAt: now,
        updatedAt: now,
      });
      log.info("argocd", `created ${tree.id}`, { name: tree.name, releases: tree.releases.length });
      res.status(201).json({ tree });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/argocd/trees/:id", (req, res) => {
    const tree = store.get(req.params.id);
    if (!tree) {
      res.status(404).json({ error: "Tree not found" });
      return;
    }
    if (!mine(tree, req)) {
      res.status(403).json({ error: "Forbidden — that tree belongs to someone else" });
      return;
    }
    res.json({ tree });
  });

  router.put("/api/argocd/trees/:id", async (req, res, next) => {
    try {
      const existing = store.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Tree not found" });
        return;
      }
      if (!mine(existing, req)) {
        res.status(403).json({ error: "Forbidden — that tree belongs to someone else" });
        return;
      }
      const body = treeBody.parse(req.body);
      // Ownership and creation time are the record's, not the request's — an
      // admin editing someone else's tree must not take it over. A blank name
      // keeps the stored one rather than emptying the list row.
      const tree = await store.put({
        ...existing,
        ...body,
        name: body.name?.trim() || existing.name,
        updatedAt: new Date().toISOString(),
      });
      log.info("argocd", `updated ${tree.id}`, { name: tree.name, releases: tree.releases.length });
      res.json({ tree });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/api/argocd/trees/:id", async (req, res, next) => {
    try {
      const existing = store.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Tree not found" });
        return;
      }
      if (!mine(existing, req)) {
        res.status(403).json({ error: "Forbidden — that tree belongs to someone else" });
        return;
      }
      await store.remove(existing.id);
      log.info("argocd", `deleted ${existing.id}`, { name: existing.name });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
