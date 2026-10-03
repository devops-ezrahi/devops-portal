import { importValues } from "./import";
import { parseValues } from "./build";
import { isPlainObject } from "./values";
import { NON_NAMESPACE_DIRS, buildTree, isTreeFile } from "./tree";
import { fingerprint } from "./diff";
import { toYaml } from "./yaml";
import type { ArgocdNamespace, ArgocdRelease, ArgocdTree, ImportedFile } from "../../../server/types";
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
  /** See ArgocdTree.imported. */
  imported: Record<string, ImportedFile>;
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
  // base/ mirrors values/'s grouping sub-folders (`base/b2b/api.yaml` for
  // `<ns>/values/b2b/api.yaml`); the release is still named after its file.
  const basePaths = new Map<string, string>();
  const bySlugRelease = new Map<string, ArgocdRelease>();
  for (const [path, text] of [...byPath].sort(([a], [b]) => a.length - b.length || a.localeCompare(b))) {
    const slug = /^base\/(?:.+\/)?([^/]+)\.yaml$/.exec(path)?.[1];
    if (!slug) continue;
    if (basePaths.has(slug)) {
      // The same release at two base paths (`base/ms2.yaml` and
      // `base/team-a/ms2.yaml`): which one a folder reads depends on the chart
      // revision deploying the repo. Identical, they are one base written to
      // both; different, the second cannot be modelled and stays as it is.
      const first = bySlugRelease.get(slug)!;
      if (sameValues(text, byPath.get(basePaths.get(slug)!)!)) first.basePaths = [...(first.basePaths ?? []), path];
      else
        warnings.push(`${path}: a second ${slug}.yaml in base, different from ${basePaths.get(slug)} — only that one is read; this file is left as it is.`);
      continue;
    }
    basePaths.set(slug, path);
    const { features, extraValues, warnings: own } = importValues(text);
    own.forEach((w) => warnings.push(`${path}: ${w}`));
    const id = uid("r");
    idBySlug.set(slug, id);
    // The file name *is* the release — the ApplicationSet names the Helm
    // release after it — so neither override renames it (a fullnameOverride is
    // the running workload's raw name, and may be templated). `file` keeps the
    // exact stem: `slug()` would turn `ms2.v2` into a second release.
    const release: ArgocdRelease = { id, name: slug, features, extraValues, file: slug, basePaths: [path] };
    bySlugRelease.set(slug, release);
    releases.push(release);
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
    // `<ns>/values/defaults.yaml` is a release called `defaults`, not the
    // defaults of a folder called `<ns>/values`.
    const defaults = /\/values\//.test(path) ? null : /^(.+)\/defaults\.yaml$/.exec(path);
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
    const defaultsText = byPath.get(`${name}/defaults.yaml`);
    const defaultsDoc = docAt(byPath, `${name}/defaults.yaml`) ?? {};
    const defaultsImport = importValues(toYaml(defaultsDoc));
    if (defaultsText !== undefined && importValues(defaultsText).unparsed)
      warnings.push(`${name}/defaults.yaml: cannot be read as a YAML mapping — kept exactly as it is.`);
    if (defaultsText === undefined)
      warnings.push(`${name}/: has values/ but no defaults.yaml, so the root ApplicationSet does not deploy it — the rebuild leaves it that way.`);
    if (Object.keys(defaultsDoc).length)
      defaultsImport.warnings
        // A group value (`color: yellow`) the base files template with
        // `{{ .Values.color }}` is the chart's to read, not a catalog field —
        // kept as extra values, which is exactly right, so nothing to warn about.
        // So is one the folder itself names (`color: black` in dev/black), even
        // when every templated value moved into the folders' own values files.
        .filter((w) => {
          const key = w.split(":")[0];
          return !templated.has(key) && !name.split("/").includes(String(defaultsDoc[key]));
        })
        .forEach((w) => warnings.push(`${name}/defaults.yaml: ${w}`));
    const entries: ArgocdNamespace["releases"] = [];
    const groups: Record<string, string> = {};

    for (const [slug, id] of idBySlug) {
      const file = valuesIn.get(name)?.get(slug);
      if (file === undefined) continue;
      if (file.group) groups[id] = file.group;
      const read = importValues(file.text);
      if (read.unparsed) {
        // Helm cannot read it either (the Application fails today). It is
        // written back byte for byte (`imported`) rather than rebuilt as `{}`,
        // which silently dropped every override in it and made the broken
        // Application deploy without them.
        warnings.push(`${file.path}: cannot be read as a YAML mapping — kept exactly as it is.`);
        continue;
      }
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
      if (!idBySlug.has(slug)) warnings.push(`${file.path}: no base/${file.group ? `${file.group}/` : ""}${slug}.yaml for it — not imported.`);
    // No values file here = this folder does not run that release.
    const absent = [...idBySlug].filter(([slug]) => !valuesIn.get(name)?.has(slug)).map(([, id]) => id);
    namespaces.push({
      name,
      ...(Object.keys(groups).length ? { groups } : {}),
      ...(absent.length ? { absent } : {}),
      releases: entries,
      defaults: { features: defaultsImport.features, extraValues: defaultsImport.extraValues },
      ...(defaultsText === undefined ? { noDefaults: true } : {}),
    });
  }

  // ---- the wiring files name the repos ---------------------------------------
  const wiring = readWiring(ROOT_APPSETS.map((p) => docAt(byPath, p)).find(Boolean) ?? null);

  // A top-level folder holding no tree file at all (the converter's input/,
  // a docs/ folder) is one line, not one per file; a stray file inside a tree
  // folder is still named on its own.
  const treeTops = new Set(["base", ...[...nsNames].map((n) => n.split("/")[0])]);
  const outside = new Map<string, number>();
  for (const path of byPath.keys()) {
    if (ROOT_FILES.includes(path)) continue;
    if (path.startsWith("base/")) continue;
    // Read above: a folder's defaults.yaml, or anything under its values/.
    if ([...nsNames].some((n) => path === `${n}/defaults.yaml` || path.startsWith(`${n}/values/`))) continue;
    const top = path.split("/")[0];
    if (path.includes("/") && !treeTops.has(top)) outside.set(top, (outside.get(top) ?? 0) + 1);
    else warnings.push(`${path}: not part of a tree this builder writes — left in the repo, not imported.`);
  }
  for (const [top, n] of outside)
    warnings.push(`${top}/: ${n} file${n === 1 ? "" : "s"} outside the tree — left in the repo, not imported.`);
  if (!releases.length) warnings.push("No `base/*.yaml` files found — this does not look like a universal-chart values repo.");

  // What the rebuild writes for each file it read, right now — kept with the
  // repo's own text so an untouched tree rebuilds byte for byte (buildTree).
  const imported: Record<string, ImportedFile> = {};
  for (const f of buildTree({ releases, namespaces } as unknown as ArgocdTree)) {
    const text = byPath.get(f.path);
    if (text !== undefined) imported[f.path] = { text, fp: fingerprint(f.text) };
  }
  for (const [path, text] of byPath) if (isTreeFile(path) && !imported[path]) imported[path] = { text, fp: "", keep: true };

  return { ...wiring, releases, namespaces, warnings, imported };
}

/** Two files Helm reads as the same values. */
function sameValues(a: string, b: string): boolean {
  const pa = parseValues(a);
  const pb = parseValues(b);
  return pa !== null && pb !== null && JSON.stringify(sortDeep(pa)) === JSON.stringify(sortDeep(pb));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
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
