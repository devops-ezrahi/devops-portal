import { importValues, releaseNameFrom } from "./import";
import { parseValues } from "./build";
import { isPlainObject } from "./values";
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
 * - A namespace override that restated one of the chart's own defaults its
 *   base file already had (`subtractChartDefaults`). Any other restated value
 *   is kept: it was set there, and dropping it read as a removal.
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

// The converter renamed them (`rootApplicationSet.yaml`, `rootApplication.yaml.txt`);
// a repo may carry either spelling. Neither is imported as values.
const ROOT_APPSETS = ["rootApplicationSet.yaml", "root-applicationSet.yaml"];
const ROOT_FILES = [...ROOT_APPSETS, "root-application.yaml", "rootApplication.yaml.txt"];

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

  // ---- namespaces: every folder holding a defaults.yaml or a values/ --------
  // A folder is a namespace (`prd`) or a variant under one (`prd/yellow`,
  // `prd/yellow/eu`) — the chart's ms-applicationSet deploys each separately
  // into the namespace its path starts with. `values/` may nest grouping
  // sub-folders (`values/group1/ms1.yaml`); the release is still the file name.
  const nsNames = new Set<string>();
  /** folder -> release slug -> { text, group } */
  const valuesIn = new Map<string, Map<string, { text: string; group: string; path: string }>>();
  for (const [path, text] of byPath) {
    if (NON_NAMESPACE_DIRS.includes(path.split("/")[0])) continue;
    const defaults = /^(.+)\/defaults\.yaml$/.exec(path);
    const values = /^(.+?)\/values\/(?:(.+)\/)?([^/]+)\.yaml$/.exec(path);
    if (defaults) nsNames.add(defaults[1]);
    if (!values) continue;
    const [, folder, group = "", slug] = values;
    nsNames.add(folder);
    const own = valuesIn.get(folder) ?? new Map();
    if (own.has(slug)) {
      warnings.push(`${path}: a second ${slug}.yaml in ${folder}/values — a release is named after its file, so only ${own.get(slug)!.path} was read.`);
      continue;
    }
    own.set(slug, { text, group, path });
    valuesIn.set(folder, own);
  }

  // Top-level keys base/ reads through tpl: `{{ .Values.color }}` -> color.
  const templated = new Set(
    [...byPath].filter(([p]) => p.startsWith("base/")).flatMap(([, t]) => [...t.matchAll(/\.Values\.(\w+)/g)].map((m) => m[1]))
  );

  const namespaces: ArgocdNamespace[] = [];
  for (const name of [...nsNames].sort()) {
    // <ns>/defaults.yaml *is* this namespace's defaults, whole — whoever wrote
    // it, the portal or the converter. Nothing is folded into the overrides:
    // they were written against base + these defaults, so they read back as
    // they are and rebuild to the same file.
    const defaultsDoc = docAt(byPath, `${name}/defaults.yaml`) ?? {};
    const defaultsImport = importValues(toYaml(defaultsDoc));
    if (Object.keys(defaultsDoc).length)
      defaultsImport.warnings
        // A group value (`color: yellow`) the base files template with
        // `{{ .Values.color }}` is the chart's to read, not a catalog field —
        // kept as extra values, which is exactly right, so nothing to warn about.
        .filter((w) => !templated.has(w.split(":")[0]))
        .forEach((w) => warnings.push(`${name}/defaults.yaml: ${w}`));
    const entries: ArgocdNamespace["releases"] = [];
    const groups: Record<string, string> = {};

    for (const [slug, id] of idBySlug) {
      const file = valuesIn.get(name)?.get(slug);
      if (file === undefined) continue;
      if (file.group) groups[id] = file.group;
      const fragment = parseValues(file.text) ?? {};
      // An empty fragment is a release this namespace runs without overriding
      // anything. The draft's own convention is to carry no entry for that —
      // writing `{}` would show a phantom override on every card.
      if (!Object.keys(fragment).length) continue;
      const imported = importValues(toYaml(fragment));
      imported.warnings.forEach((w) => warnings.push(`${file.path}: ${w}`));
      entries.push({ release: id, features: imported.features, extraValues: imported.extraValues });
    }
    for (const [slug, file] of valuesIn.get(name) ?? [])
      if (!idBySlug.has(slug)) warnings.push(`${file.path}: no base/${slug}.yaml for it — not imported.`);
    // No values file here = this folder does not run that release.
    const absent = [...idBySlug].filter(([slug]) => !valuesIn.get(name)?.has(slug)).map(([, id]) => id);
    namespaces.push({
      name,
      ...(Object.keys(groups).length ? { groups } : {}),
      ...(absent.length ? { absent } : {}),
      releases: entries,
      defaults: { features: defaultsImport.features, extraValues: defaultsImport.extraValues },
    });
  }

  // ---- the wiring files name the repos ---------------------------------------
  const wiring = readWiring(ROOT_APPSETS.map((p) => docAt(byPath, p)).find(Boolean) ?? null);

  for (const path of byPath.keys()) {
    if (ROOT_FILES.includes(path)) continue;
    if (path.startsWith("base/")) continue;
    // Read above: a folder's defaults.yaml, or anything under its values/.
    if ([...nsNames].some((n) => path === `${n}/defaults.yaml` || path.startsWith(`${n}/values/`))) continue;
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
