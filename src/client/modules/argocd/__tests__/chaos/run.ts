import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { importTree } from "../../importTree";
import { buildTree, fileStem, isTreeFile } from "../../tree";
import { commitFiles, diffTree } from "../../diff";
import { deploy, diffValues, drift } from "./argo";
import type { ArgocdTree } from "../../../../../server/types";
import type { Case, Files } from "./cases";
import type { BaseLayout, Deployment, Drift } from "./argo";

/**
 * One chaos case, end to end, the way the portal handles a real repo:
 *
 *   pull     `pullValuesTree` reads only *.yaml / *.yml
 *   import   `importTree` (and the tree keeps its `imported` map, as the UI does)
 *   build    `buildTree`
 *   preview  `diffTree` against the pulled files — what the user is shown
 *   push     `commitFiles`, then at the repo root: written over the clone,
 *            nothing deleted ("overlay"); under `values.path`: the tree's own
 *            files it no longer writes removed first ("replace")
 *
 * and the Argo oracle run on the repo before and after each push. Then the same
 * again after one edit, to prove the preview and the deploy move by exactly it.
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
  /** What the preview shows for an untouched pull: every entry but `unchanged`, as `status path`. */
  diffShown: string[];
  /** Files an untouched push would commit with text different from the repo's. */
  committed: string[];
  /**
   * An edit made in the portal after the import — a `chaosProbe: <release>` key
   * on each release's base — and the Applications that do not see it once the
   * rebuild is pushed. A base file Argo never reads would make every later
   * edit a no-op.
   */
  unseenEdits: string[];
  /** One image-tag edit: what the preview and the deploy show beyond exactly that. `[]` = exact. */
  editProblems: string[];
  /** The Application that edit was made to — none only when nothing renders at all. */
  edited?: string;
};

export function readTree(dir: string): Files {
  const walk = (d: string): string[] =>
    readdirSync(d)
      .filter((n) => n !== ".git")
      .flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk(dir).map((f) => ({ path: relative(dir, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));
}

const pulled = (files: Files) => files.filter((f) => /\.ya?ml$/.test(f.path));

/** The repo after a push of `sent`: written over it, and (replace) the tree's unsent own files removed. */
function pushed(repo: Files, sent: Files, mode: "overlay" | "replace"): Files {
  const paths = new Set(sent.map((f) => f.path));
  return [...repo.filter((f) => !paths.has(f.path) && (mode === "overlay" || !isTreeFile(f.path))), ...sent];
}

const EDIT_TAG = "9.9.9-chaos-edit";

export function runCase(seed: Files, c: Case, layout: BaseLayout = "mirrored"): Outcome {
  const repo = c.mutate(seed);
  const before = deploy(repo, layout);
  const base = { id: c.id, family: c.family, title: c.title, before, diffShown: [], committed: [], unseenEdits: [], editProblems: [] };
  let tree: ArgocdTree;
  let warnings: string[] = [];
  try {
    const imported = importTree(pulled(repo));
    warnings = imported.warnings;
    tree = { releases: imported.releases, namespaces: imported.namespaces, imported: imported.imported } as unknown as ArgocdTree;
  } catch (err) {
    return { ...base, warnings, crash: err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n")}` : String(err) };
  }
  const repoYaml = pulled(repo);
  const build = (t: ArgocdTree) => buildTree(t).map(({ path, text, note }) => ({ path, text, note }));
  let built: ReturnType<typeof build>;
  try {
    built = build(tree);
  } catch (err) {
    return { ...base, warnings, crash: err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 4).join("\n")}` : String(err) };
  }

  // The preview, untouched: nothing but `unchanged`, and nothing to commit.
  const diffShown = [
    ...diffTree(built, repoYaml, false),
    ...diffTree(built, repoYaml, true).filter((e) => e.status === "removed"),
  ]
    .filter((e) => e.status !== "unchanged")
    .map((e) => `${e.status} ${e.path}${e.status === "removed" ? " (under values.path)" : ""}`);
  const sent = commitFiles(built, repoYaml);
  const byPath = new Map(repo.map((f) => [f.path, f.text]));
  const committed = sent.filter((f) => byPath.get(f.path) !== f.text).map((f) => f.path);

  const overlay = deploy(pushed(repo, sent, "overlay"), layout);
  const replace = deploy(pushed(repo, sent, "replace"), layout);

  // A base edit must reach every Application running the release.
  const probe = build({
    ...tree,
    releases: tree.releases.map((r) => ({ ...r, extraValues: `${r.extraValues ?? ""}\nchaosProbe: ${JSON.stringify(r.name)}\n` })),
  });
  const probedApps = deploy(pushed(repo, commitFiles(probe, repoYaml), "overlay"), layout).apps;
  const unseenEdits = [...probedApps.values()]
    .filter((a) => !a.error && a.values?.chaosProbe === undefined)
    .map((a) => `${a.name} (reads ${a.valueFiles[0]})`);

  return {
    ...base,
    warnings,
    diffShown,
    committed,
    unseenEdits,
    ...oneEdit(tree, repo, repoYaml, before, layout, build),
    overlay: { deployment: overlay, drift: drift(before, overlay) },
    replace: { deployment: replace, drift: drift(before, replace) },
  };
}

/**
 * Change one Application's image tag in its namespace values file — the
 * commonest edit there is — and check the preview shows exactly that file
 * modified and Argo deploys exactly that change, nowhere else.
 */
function oneEdit(
  tree: ArgocdTree,
  repo: Files,
  repoYaml: Files,
  before: Deployment,
  layout: BaseLayout,
  build: (t: ArgocdTree) => { path: string; text: string; note: string }[]
): { editProblems: string[]; edited?: string } {
  const target = [...before.apps.values()].find((a) => {
    if (a.error) return false;
    const ns = tree.namespaces.find((n) => n.name === a.folder);
    const r = tree.releases.find((x) => fileStem(x) === a.release);
    return ns && r && !ns.absent?.includes(r.id) && a.valueFiles[2] === `${ns.name}/values/${ns.groups?.[r.id] ? `${ns.groups[r.id]}/` : ""}${fileStem(r)}.yaml`;
  });
  if (!target) return { editProblems: [] };
  const ns = tree.namespaces.find((n) => n.name === target.folder)!;
  const release = tree.releases.find((x) => fileStem(x) === target.release)!;
  const entry = ns.releases.find((e) => e.release === release.id);
  const extra = `${entry?.extraValues ?? ""}\nimage:\n  tag: ${EDIT_TAG}\n`;
  const edited = {
    ...tree,
    namespaces: tree.namespaces.map((n) =>
      n !== ns
        ? n
        : {
            ...n,
            releases: entry
              ? n.releases.map((e) => (e === entry ? { ...e, extraValues: extra } : e))
              : [...n.releases, { release: release.id, features: {}, extraValues: extra }],
          }
    ),
  } as ArgocdTree;
  const files = build(edited);
  const problems: string[] = [];
  const shown = diffTree(files, repoYaml, false).filter((e) => e.status !== "unchanged");
  const file = target.valueFiles[2];
  if (shown.length !== 1 || shown[0].path !== file || shown[0].status !== "modified")
    problems.push(`preview after editing ${file}: ${shown.map((e) => `${e.status} ${e.path}`).join(", ") || "nothing"}`);
  const after = deploy(pushed(repo, commitFiles(files, repoYaml), "overlay"), layout);
  for (const d of drift(before, after)) {
    if (d.app !== target.name) problems.push(`deploy after the edit: ${d.app} ${d.kind}: ${d.detail}`);
    else {
      const moved = diffValues(before.apps.get(d.app)!.values!, after.apps.get(d.app)!.values!);
      const onlyTag = moved.length === 1 && (moved[0].startsWith("image.tag:") || moved[0] === `image: <unset> -> {"tag":"${EDIT_TAG}"}`);
      if (!onlyTag) problems.push(`deploy after the edit: ${d.app}: ${moved.join("; ")}`);
    }
  }
  if (!drift(before, after).some((d) => d.app === target.name)) problems.push(`deploy after the edit: ${target.name}'s tag did not change`);
  return { editProblems: problems, edited: target.name };
}
