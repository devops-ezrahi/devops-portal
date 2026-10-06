import { parseAllDocuments, visit } from "yaml";
import type { RepoFile } from "../../importTree";

/**
 * What Argo CD deploys from a values repo, worked out the way the
 * universal-chart repo's own wiring does it — not the way this module thinks
 * it does. The oracle the chaos suite judges `importTree -> buildTree` by.
 *
 *   rootApplicationSet.yaml   git files generator `** /defaults.yaml`:
 *                             one ms-applicationSet per folder holding one,
 *                             namespace = the folder's first segment
 *   ms-applicationSet         git files generator `<folder>/values/*.yaml`
 *                             (legacy globbing: `*` crosses `/`), one
 *                             Application per file, named
 *                             `<file>-<last dash segment of ns><-variant>`,
 *                             valueFiles:
 *                               base/<file name>          (flat — the group folder is not kept)
 *                               <folder>/defaults.yaml
 *                               <the file itself>
 *
 * (`ms-applicationSet/templates/applicationSet.yaml` in universal-chart.)
 *
 * Values are read the way Helm reads them: YAML 1.1 (`yes` is true, `0644` is
 * octal), the first document only, a parse error fails the render, and files
 * merge in order with maps merged and everything else replaced.
 */

export type Values = Record<string, unknown>;

export type App = {
  name: string;
  namespace: string;
  folder: string;
  release: string;
  valueFiles: string[];
  /** The merged values Helm would render with — or why it cannot render. */
  values?: Values;
  error?: string;
};

export type Deployment = {
  apps: Map<string, App>;
  /** Two Applications with one name: the ApplicationSet controller refuses the set. */
  collisions: string[];
};

const isMap = (v: unknown): v is Values => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A plain (unquoted) scalar the way go-yaml v2 — Helm's reader — types it,
 * checked against `helm template` itself: `y`/`yes`/`on` are booleans, a
 * leading zero is octal, `0x`/`0o`/`0b` and `_` digit separators are integers,
 * but `12:30` and `2001-12-14` stay strings, and `.inf` / `.nan` cannot be
 * rendered at all (JSON has no such number).
 */
function goYamlPlain(src: string): unknown {
  if (/^(~|null|Null|NULL|)$/.test(src)) return null;
  if (/^(y|Y|yes|Yes|YES|on|On|ON|true|True|TRUE)$/.test(src)) return true;
  if (/^(n|N|no|No|NO|off|Off|OFF|false|False|FALSE)$/.test(src)) return false;
  if (/^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(src)) throw new Error(`json: unsupported value: ${src}`);
  const sign = src.startsWith("-") ? -1 : 1;
  const digits = src.replace(/^[-+]/, "").replace(/_/g, "");
  const int = (re: RegExp, radix: number, skip: number) => (re.test(digits) ? sign * parseInt(digits.slice(skip), radix) : undefined);
  const asInt =
    int(/^0[xX][0-9a-fA-F]+$/, 16, 2) ??
    int(/^0[oO][0-7]+$/, 8, 2) ??
    int(/^0[bB][01]+$/, 2, 2) ??
    int(/^0[0-7]+$/, 8, 1) ??
    int(/^(0|[1-9][0-9]*)$/, 10, 0);
  if (asInt !== undefined) return asInt;
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(src)) return parseFloat(src);
  return src;
}

/** One values file as Helm sees it: a map, `{}` for an empty file, or a parse error. */
export function helmParse(text: string): { doc?: Values; error?: string } {
  // Helm reads the first document; a repeated key is not an error, the last one wins.
  const first = parseAllDocuments(text.replace(/^\uFEFF/, ""), { version: "1.1", uniqueKeys: false, merge: true });
  const doc = Array.isArray(first) ? first[0] : first;
  if (!doc) return { doc: {} };
  if (doc.errors.length) return { error: doc.errors[0].message.split("\n")[0] };
  try {
    visit(doc, {
      Scalar(key, node) {
        if (key !== "key" && node.type === "PLAIN" && typeof node.source === "string") node.value = goYamlPlain(node.source);
      },
    });
  } catch (err) {
    return { error: (err as Error).message };
  }
  const js = doc.toJS({ maxAliasCount: -1 }) as unknown;
  if (js === null || js === undefined) return { doc: {} };
  if (!isMap(js)) return { error: "values file is not a map" };
  return { doc: js };
}

/** Helm's mergeMaps: maps merge key by key, anything else (lists, scalars, null) replaces. */
export function helmMerge(base: Values, over: Values): Values {
  const out: Values = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isMap(v) && isMap(out[k]) ? helmMerge(out[k] as Values, v) : v;
  return out;
}

/** `helm template` / `helm install` reject any other release name — and the file name is the release name. */
const HELM_RELEASE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * Where an Application's base file is, which depends on the chart revision the
 * repo deploys with. universal-chart `main` reads `base/<file>` whatever
 * sub-folder of values/ the file sits in ("flat"); `dev` mirrors the sub-folder,
 * `base/<group>/<file>` ("mirrored") — the layout the portal writes.
 */
export type BaseLayout = "flat" | "mirrored";

export function deploy(files: RepoFile[], layout: BaseLayout = "mirrored"): Deployment {
  const byPath = new Map(files.map((f) => [f.path.replace(/^\.?\//, ""), f.text]));
  const apps = new Map<string, App>();
  const collisions: string[] = [];
  const folders = [...byPath.keys()]
    .filter((p) => /(^|\/)defaults\.yaml$/.test(p) && p.includes("/"))
    .map((p) => p.slice(0, -"/defaults.yaml".length))
    .sort();
  for (const folder of folders) {
    const ns = folder.split("/")[0];
    const suffix = folder === ns ? "" : `-${folder.slice(ns.length + 1).replace(/\//g, "-")}`;
    const prefix = `${folder}/values/`;
    for (const path of [...byPath.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".yaml")).sort()) {
      const file = path.split("/").pop()!;
      const release = file.slice(0, -".yaml".length);
      const name = `${release}-${ns.split("-").pop()}${suffix}`;
      const sub = path.slice(prefix.length, -file.length);
      const valueFiles = [`base/${layout === "flat" ? "" : sub}${file}`, `${folder}/defaults.yaml`, path];
      const app: App = { name, namespace: ns, folder, release, valueFiles };
      let merged: Values = {};
      // Helm refuses the release before reading a single values file.
      if (!HELM_RELEASE_NAME.test(release) || release.length > 53) app.error = `release name "${release}": invalid release name`;
      for (const vf of app.error ? [] : valueFiles) {
        const text = byPath.get(vf);
        if (text === undefined) {
          app.error = `${vf}: no such file`;
          break;
        }
        const { doc, error } = helmParse(text);
        if (error) {
          app.error = `${vf}: ${error}`;
          break;
        }
        merged = helmMerge(merged, doc!);
      }
      if (!app.error) app.values = merged;
      if (apps.has(name)) collisions.push(name);
      apps.set(name, app);
    }
  }
  return { apps, collisions };
}

export type Drift = { app: string; kind: "lost" | "added" | "now-fails" | "now-renders" | "values" | "error-changed"; detail: string };

/** Every way the second deployment differs from the first, Application by Application. */
export function drift(before: Deployment, after: Deployment): Drift[] {
  const out: Drift[] = [];
  for (const [name, a] of before.apps) {
    const b = after.apps.get(name);
    if (!b) out.push({ app: name, kind: "lost", detail: a.error ? `(was failing: ${a.error})` : "was deployed, no longer is" });
    else if (!a.error && b.error) out.push({ app: name, kind: "now-fails", detail: b.error });
    else if (a.error && !b.error) out.push({ app: name, kind: "now-renders", detail: `was: ${a.error}` });
    else if (a.error && b.error) {
      if (a.error !== b.error) out.push({ app: name, kind: "error-changed", detail: `${a.error} -> ${b.error}` });
    } else {
      const d = diffValues(a.values!, b.values!);
      if (d.length) out.push({ app: name, kind: "values", detail: d.slice(0, 6).join("; ") + (d.length > 6 ? ` (+${d.length - 6} more)` : "") });
    }
  }
  for (const [name, b] of after.apps)
    if (!before.apps.has(name)) out.push({ app: name, kind: "added", detail: b.error ? `fails: ${b.error}` : "newly deployed" });
  return out;
}

/** JSON with map keys sorted: key order inside a list item is not a difference Helm sees. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (isMap(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

const show = (v: unknown) => (v === undefined ? "<unset>" : JSON.stringify(v));

export function diffValues(a: unknown, b: unknown, path = ""): string[] {
  if (isMap(a) && isMap(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffValues(a[k], b[k], path ? `${path}.${k}` : k));
  }
  if (canon(a) === canon(b)) return [];
  return [`${path || "<root>"}: ${show(a)} -> ${show(b)}`];
}
