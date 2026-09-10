import { importValues, releaseNameFrom } from "./import";
import { parseValues } from "./build";
import { deepMerge, isPlainObject } from "./values";
import { NON_NAMESPACE_DIRS } from "./tree";
import { toYaml } from "./yaml";
import type { ArgocdNamespace, ArgocdRelease, ArgocdTree } from "../../../server/types";
import type { Values } from "./values";

/**
 * A whole values repo back into a tree — `buildTree`'s inverse.
 *
 * `import.ts` reverses one `values.yaml` into one layer's catalog state; this
 * reverses the *layout* around those files, and calls it once per document.
 * Both follow the same rule: nothing is dropped silently. What a re-emit cannot
 * reproduce lands in `extraValues` and is named in `warnings`.
 *
 * **The round trip is exact for files, not for bytes.** `buildTree ->
 * importTree -> buildTree` produces the same paths and the same parsed
 * documents, but two things do not survive:
 *
 * - A release's display name. The only place it is written is the file *name*
 *   and a header comment, so `API Gateway` comes back as `api-gateway` unless
 *   the chart sets `nameOverride`. `slug` is idempotent, so a second round trip
 *   is byte-stable.
 * - A namespace override that restated a value its base file already had.
 *   `subtractDefaults` dropped it on the way out, because it is a no-op in the
 *   deployed document — and a re-emit drops it again.
 *
 * A tree written by `convert_to_universal_chart.py` rather than by this builder
 * imports on the same terms, with its comments and key order gone.
 */

export type TreeImport = {
  chart?: ArgocdTree["chart"];
  values?: ArgocdTree["values"];
  rootAppName?: string;
  releases: ArgocdRelease[];
  namespaces: ArgocdNamespace[];
  warnings: string[];
};

export type RepoFile = { path: string; text: string };

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;

const ROOT_APPSET = "root-applicationSet.yaml";
const ROOT_APP = "root-application.yaml";

export function importTree(files: RepoFile[]): TreeImport {
  const warnings: string[] = [];
  const byPath = new Map(files.map((f) => [f.path.replace(/^\.?\//, ""), f.text]));

  // ---- releases: base/ is written whole, so each file *is* that release -----
  const releases: ArgocdRelease[] = [];
  const idBySlug = new Map<string, string>();
  for (const [path, text] of byPath) {
    const slug = path.startsWith("base/") && path.endsWith(".yaml") ? path.slice(5, -5) : null;
    if (!slug || slug.includes("/")) continue;
    const { features, extraValues, warnings: own } = importValues(text);
    own.forEach((w) => warnings.push(`${path}: ${w}`));
    const id = uid("r");
    idBySlug.set(slug, id);
    releases.push({ id, name: releaseNameFrom(text) || slug, features, extraValues });
  }
  releases.sort((a, b) => a.name.localeCompare(b.name));

  // ---- namespaces: every other top-level directory --------------------------
  const nsNames = new Set<string>();
  for (const path of byPath.keys()) {
    const [dir, ...rest] = path.split("/");
    if (!rest.length || NON_NAMESPACE_DIRS.includes(dir)) continue;
    nsNames.add(dir);
  }

  const namespaces: ArgocdNamespace[] = [];
  for (const name of [...nsNames].sort()) {
    // Namespace defaults sit *below* the base file, and `commonSubtree` put
    // there only paths every one of this namespace's fragments held identically
    // — so merging the whole of it back into each fragment is exact, not an
    // approximation. `withoutClaimed` having shrunk it changes nothing: a path
    // some base file claimed either sat in that base (and was subtracted out of
    // the override, a deployed no-op) or survived in the override itself.
    const nsDefaults = docAt(byPath, `${name}/defaults.yaml`) ?? {};
    const entries: ArgocdNamespace["releases"] = [];

    for (const [slug, id] of idBySlug) {
      const text = byPath.get(`${name}/values/${slug}.yaml`);
      if (text === undefined) continue;
      const fragment = deepMerge(nsDefaults, parseValues(text) ?? {});
      // An empty fragment is a release this namespace runs without overriding
      // anything. The draft's own convention is to carry no entry for that —
      // writing `{}` would show a phantom override on every card.
      if (!Object.keys(fragment).length) continue;
      const imported = importValues(toYaml(fragment));
      imported.warnings.forEach((w) => warnings.push(`${name}/values/${slug}.yaml: ${w}`));
      entries.push({ release: id, features: imported.features, extraValues: imported.extraValues });
    }
    namespaces.push({ name, releases: entries });
  }

  // ---- the wiring files name the repos ---------------------------------------
  const wiring = readWiring(docAt(byPath, ROOT_APPSET));

  for (const path of byPath.keys()) {
    if (path === ROOT_APPSET || path === ROOT_APP) continue;
    if (path.startsWith("base/") || [...nsNames].some((n) => path.startsWith(`${n}/`))) continue;
    warnings.push(`${path}: not part of a tree this builder writes — left in the repo, not imported.`);
  }
  if (!releases.length) warnings.push("No `base/*.yaml` files found — this does not look like a universal-chart values repo.");

  return { ...wiring, releases, namespaces, warnings };
}

function docAt(byPath: Map<string, string>, path: string): Values | null {
  const text = byPath.get(path);
  return text === undefined ? null : parseValues(text);
}

/**
 * `root-applicationSet.yaml` back into the two repo blocks — the exact inverse
 * of `rootApplicationSet`. Absent (a hand-built tree, or one folded into a
 * bigger repo) just means the fields keep whatever the pull dialog was given.
 */
function readWiring(doc: Values | null): Pick<TreeImport, "chart" | "values" | "rootAppName"> {
  if (!doc) return {};
  const spec = at(doc, "spec");
  const generator = at(spec, "generators.0.git");
  const source = at(spec, "template.spec.sources.0");
  const params = new Map<string, string>();
  const list = at(source, "helm.parameters");
  if (Array.isArray(list))
    list.forEach((p) => {
      if (isPlainObject(p) && typeof p.name === "string") params.set(p.name, String(p.value ?? ""));
    });

  const name = str(at(doc, "metadata.name")).replace(/-set$/, "");
  const values = {
    repoUrl: str(at(generator, "repoURL")) || params.get("originRepoURL") || "",
    revision: str(at(generator, "revision")) || params.get("originBranch") || "main",
    path: params.get("originPath") ?? "",
  };
  const chart = {
    repoUrl: params.get("chartRepoURL") || str(at(source, "repoURL")),
    path: params.get("chartPath") || ".",
    appsetPath: str(at(source, "path")) || "ms-applicationSet",
    revision: params.get("chartRevision") || str(at(source, "targetRevision")) || "main",
  };
  return {
    ...(values.repoUrl ? { values } : {}),
    ...(chart.repoUrl ? { chart } : {}),
    ...(name ? { rootAppName: name } : {}),
  };
}

/** `a.b.0.c` through maps and arrays alike. */
function at(node: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (Array.isArray(cur)) return cur[Number(key)];
    return isPlainObject(cur) ? cur[key] : undefined;
  }, node);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
