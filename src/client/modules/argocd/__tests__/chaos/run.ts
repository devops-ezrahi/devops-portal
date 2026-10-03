import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { importTree } from "../../importTree";
import { buildTree } from "../../tree";
import { deploy, drift } from "./argo";
import type { ArgocdTree } from "../../../../../server/types";
import type { Case, Files } from "./cases";
import type { BaseLayout, Deployment, Drift } from "./argo";

/**
 * One chaos case, end to end, the way the portal handles a real repo:
 *
 *   pull     `pullValuesTree` reads only *.yaml / *.yml
 *   import   `importTree`
 *   build    `buildTree`
 *   push     at the repo root: built files written over the clone, nothing
 *            deleted ("overlay"); under `values.path`: that folder emptied
 *            first, then written ("replace")
 *
 * and the Argo oracle run on the repo before and after each push.
 */

export type Outcome = {
  id: string;
  family: string;
  title: string;
  crash?: string;
  warnings: string[];
  before: Deployment;
  overlay?: { deployment: Deployment; drift: Drift[] };
  replace?: { deployment: Deployment; drift: Drift[] };
  /** Paths the rebuild writes that were not in the repo, and repo paths it does not write. */
  written: string[];
  notWritten: string[];
  /**
   * An edit made in the portal after the import — a `chaosProbe: <release>` key
   * on each release's base — and the Applications that do not see it once the
   * rebuild is pushed. A base file Argo never reads would make every later
   * edit a no-op.
   */
  unseenEdits: string[];
};

export function readTree(dir: string): Files {
  const walk = (d: string): string[] =>
    readdirSync(d)
      .filter((n) => n !== ".git")
      .flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk(dir).map((f) => ({ path: relative(dir, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));
}

const pulled = (files: Files) => files.filter((f) => /\.ya?ml$/.test(f.path));

export function runCase(seed: Files, c: Case, layout: BaseLayout = "mirrored"): Outcome {
  const repo = c.mutate(seed);
  const before = deploy(repo, layout);
  const base = { id: c.id, family: c.family, title: c.title, before, written: [], notWritten: [], unseenEdits: [] };
  let built: Files;
  let probed: Files;
  let warnings: string[] = [];
  try {
    const imported = importTree(pulled(repo));
    warnings = imported.warnings;
    const tree = { releases: imported.releases, namespaces: imported.namespaces } as unknown as ArgocdTree;
    built = buildTree(tree).map(({ path, text }) => ({ path, text }));
    const edited = {
      ...tree,
      releases: tree.releases.map((r) => ({ ...r, extraValues: `${r.extraValues ?? ""}\nchaosProbe: ${JSON.stringify(r.name)}\n` })),
    } as ArgocdTree;
    probed = buildTree(edited).map(({ path, text }) => ({ path, text }));
  } catch (err) {
    return { ...base, warnings, crash: err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n")}` : String(err) };
  }
  const builtPaths = new Set(built.map((f) => f.path));
  const repoPaths = new Set(repo.map((f) => f.path));
  const overlayRepo = [...repo.filter((f) => !builtPaths.has(f.path)), ...built];
  const overlay = deploy(overlayRepo, layout);
  const replace = deploy(built, layout);
  const probedPaths = new Set(probed.map((f) => f.path));
  const probedApps = deploy([...repo.filter((f) => !probedPaths.has(f.path)), ...probed], layout).apps;
  const unseenEdits = [...probedApps.values()]
    .filter((a) => !a.error && a.values?.chaosProbe === undefined)
    .map((a) => `${a.name} (reads ${a.valueFiles[0]})`);
  return {
    ...base,
    warnings,
    unseenEdits,
    overlay: { deployment: overlay, drift: drift(before, overlay) },
    replace: { deployment: replace, drift: drift(before, replace) },
    written: [...builtPaths].filter((p) => !repoPaths.has(p)).sort(),
    notWritten: pulled(repo)
      .map((f) => f.path)
      .filter((p) => !builtPaths.has(p) && !p.startsWith("root"))
      .sort(),
  };
}
