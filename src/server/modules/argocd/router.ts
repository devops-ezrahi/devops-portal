import express from "express";
import { z } from "zod";
import { isAdmin } from "../../auth";
import { config } from "../../config";
import { normalizeRepoUrl } from "../../gitUrl";
import { log } from "../../log";
import { TreeStore } from "./TreeStore";
import { pullValuesTree, pushValuesTree } from "./valuesGit";
import { safeDirPath, safeRef, safeRepoUrl, safeTreePath } from "./valuesRepo";
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
    // Normalised at rest rather than only in the dialog: a tree can reach this
    // through an import or a hand-edited field too, and `safeRepoUrl` refuses
    // everything but http(s) — so an SSH URL stored verbatim is a tree whose
    // push fails later, with the reason three screens away.
    repoUrl: z.string().trim().max(300).transform(normalizeRepoUrl),
    path: z.string().trim().max(200),
    appsetPath: z.string().trim().max(200),
    revision: z.string().trim().max(100),
  }),
  values: z.object({
    repoUrl: z.string().trim().max(300).transform(normalizeRepoUrl),
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

/**
 * Where to read a tree from. Not scoped to a saved tree: a draft with only a
 * repo URL typed into it is never written (`isEmptyTree`), so a first pull has
 * no `:id` to hang off.
 */
const pullBody = z.object({
  // `transform` runs before `refine`, so the SSH form is rewritten and *then*
  // checked — which is what lets someone paste the URL their git host showed
  // them without the portal needing an SSH key.
  repoUrl: z.string().trim().max(300).transform(normalizeRepoUrl).refine(safeRepoUrl, "Only http(s) git URLs can be cloned"),
  revision: z.string().trim().max(100).refine(safeRef, "Not a branch or tag name"),
  path: z.string().trim().max(200).refine(safeDirPath, "Not a path inside the repository"),
});

/**
 * The files to commit.
 *
 * They are generated in the browser, because `buildTree` and the 2 000-line
 * catalog it depends on live there and what the preview shows must be what gets
 * committed. That makes this body a trust boundary onto a git worktree the
 * server then runs commands in — hence `safeTreePath` per file, and the
 * `resolve()` containment check again at the write site.
 *
 * The *destination* is deliberately absent: repo, revision and path are read
 * from the stored record after the ownership check, never from the request.
 */
const pushBody = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(200).refine(safeTreePath, "Unsafe file path"),
        text: z.string().max(256_000),
      })
    )
    .min(1)
    .max(500)
    .refine((f) => f.reduce((n, x) => n + x.text.length, 0) <= 2 * 1024 * 1024, "Tree is larger than 2 MB"),
  branch: z.string().trim().max(100).refine(safeRef, "Not a branch name").optional(),
  message: z.string().trim().min(1).max(200).optional(),
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
      // So the two git buttons render disabled with a reason, instead of
      // failing on click. Same trick as `defaults`: no second request.
      gitEnabled: !!(config.argocd.valuesToken || config.git.enabled),
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

  /**
   * Read an existing values tree out of git. The reversal back into releases and
   * namespaces happens in the browser, where `importValues` and the catalog are.
   */
  router.post("/api/argocd/pull", async (req, res, next) => {
    try {
      const { repoUrl, revision, path } = pullBody.parse(req.body);
      const files = await pullValuesTree(repoUrl, revision, path);
      if (!files.length) {
        res.status(404).json({ error: `No YAML files under ${path || "the repository root"} on ${revision}` });
        return;
      }
      // `repoUrl` is echoed because it may not be the one that was sent — an
      // SSH URL was rewritten above, and the tree should record what cloned.
      res.json({ files, repoUrl });
    } catch (err) {
      next(err);
    }
  });

  /** Commit the generated tree onto this tree's own branch and open a PR. */
  router.post("/api/argocd/trees/:id/push", async (req, res, next) => {
    try {
      const tree = store.get(req.params.id);
      if (!tree) {
        res.status(404).json({ error: "Tree not found" });
        return;
      }
      if (!mine(tree, req)) {
        res.status(403).json({ error: "Forbidden — that tree belongs to someone else" });
        return;
      }
      const body = pushBody.parse(req.body);
      if (!safeRepoUrl(tree.values.repoUrl) || !safeRef(tree.values.revision) || !safeDirPath(tree.values.path ?? "")) {
        res.status(400).json({ error: "This tree's values repository, revision or path is not something git can be pointed at." });
        return;
      }
      const result = await pushValuesTree({
        tree,
        files: body.files,
        branch: body.branch || `portal/argocd-${tree.id.toLowerCase()}`,
        message: body.message || `Update ${tree.name} GitOps tree`,
        authorName: req.user!.displayName,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
