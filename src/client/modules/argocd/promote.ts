import { importValues } from "./import";
import { buildValues } from "./build";
import { commonSubtree, deepEqual, isPlainObject, subtractDefaults } from "./values";
import { toYaml } from "./yaml";
import type { ArgocdRelease, ArgocdTree } from "../../../server/types";
import type { FeatureState } from "./catalog";
import type { Values } from "./values";

/**
 * A value every namespace sets the same way is not an override — it is the
 * base, written out N times.
 *
 * The layering hides this: each namespace file is subtracted against base, so
 * the repeated value survives in all of them and the base file never gains it.
 * Nothing is broken, but the same line has to be edited in every namespace, and
 * the base file stops describing the microservice.
 *
 * This finds those values and moves them down a layer. It reuses
 * `commonSubtree` — the same function `buildTree` uses to compute
 * `<ns>/defaults.yaml`, and the one ported from the converter — so "identical
 * across namespaces" means exactly what it means everywhere else.
 */

export type Promotion = {
  /** The microservice this is about. */
  releaseId: string;
  releaseName: string;
  /** What every namespace agrees on, as a values fragment. */
  values: Values;
  /** `image.tag`, `replicaCount` — the paths, for the sentence on screen. */
  paths: string[];
  /** The namespaces that all said the same thing. */
  namespaces: string[];
};

/** Every leaf path in a document, dotted. */
function leafPaths(doc: Values, prefix = ""): string[] {
  return Object.entries(doc).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isPlainObject(v) && Object.keys(v).length ? leafPaths(v, path) : [path];
  });
}

/**
 * What could move from every namespace's override into the microservice's base.
 *
 * Only when **every** namespace overrides the microservice: two namespaces
 * agreeing while a third says nothing means the third is on the base value, and
 * promoting the other two's would change what the third deploys.
 */
export function findPromotions(tree: ArgocdTree): Promotion[] {
  const namespaces = tree.namespaces.filter((n) => n.name.trim());
  if (namespaces.length < 2) return [];

  const out: Promotion[] = [];
  for (const release of tree.releases) {
    const fragments: Values[] = [];
    for (const ns of namespaces) {
      const entry = ns.releases.find((e) => e.release === release.id);
      const doc = entry ? buildValues(entry.features, entry.extraValues) : {};
      if (!Object.keys(doc).length) break; // this namespace overrides nothing
      fragments.push(doc);
    }
    if (fragments.length !== namespaces.length) continue;

    const shared = commonSubtree(fragments);
    // Anything base already says is not a promotion — it is a no-op restated.
    const base = buildValues(release.features, release.extraValues);
    const novel = subtractDefaults(shared, base);
    if (!Object.keys(novel).length) continue;

    out.push({
      releaseId: release.id,
      releaseName: release.name.trim() || "unnamed",
      values: novel,
      paths: leafPaths(novel),
      namespaces: namespaces.map((n) => n.name),
    });
  }
  return out;
}

/**
 * Apply one: merge the shared values into the microservice's base, and take
 * them back out of every namespace that was repeating them.
 *
 * Both halves go through `importValues`, so the result is catalog state rather
 * than raw YAML — a promoted value lands in the field it belongs to and stays
 * editable. Whatever the catalog cannot model comes back as `extraValues`,
 * exactly as it does on an import.
 */
export function applyPromotion(tree: ArgocdTree, promotion: Promotion): ArgocdTree {
  const { releaseId, values } = promotion;

  const releases = tree.releases.map((r) => {
    if (r.id !== releaseId) return r;
    const merged = { ...buildValues(r.features, r.extraValues) };
    return withValues(r, deepMergeInto(merged, values));
  });

  const namespaces = tree.namespaces.map((ns) => ({
    ...ns,
    releases: ns.releases.map((entry) => {
      if (entry.release !== releaseId) return entry;
      const doc = buildValues(entry.features, entry.extraValues);
      const left = subtractDefaults(doc, values);
      const imported = importValues(toYaml(left));
      return { ...entry, features: imported.features, extraValues: imported.extraValues };
    }),
  }));

  return { ...tree, releases, namespaces };
}

/** `deepMerge` with the override winning, but returning the same object shape the catalog reads. */
function deepMergeInto(base: Values, over: Values): Values {
  const out: Values = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMergeInto(out[k] as Values, v) : v;
  }
  return out;
}

function withValues(release: ArgocdRelease, doc: Values): ArgocdRelease {
  const imported = importValues(toYaml(doc));
  return { ...release, features: imported.features as Record<string, FeatureState>, extraValues: imported.extraValues };
}

/** Whether two documents say the same thing — used by the tests. */
export const sameDoc = (a: Values, b: Values) => deepEqual(a, b);

/* ---------------------------------------------------------------------------
 * The other direction: base holding something only an environment can answer.
 * ------------------------------------------------------------------------- */

/**
 * `base/<release>.yaml` is environment-agnostic by design — every namespace
 * renders it, so a value in there is a statement about the microservice, not
 * about where it runs. An image tag, a hostname or a pod count in base is
 * therefore usually a value that was typed into the only file open at the time
 * and then quietly shipped to every environment.
 *
 * This is the mirror of `findPromotions`, and it is deliberately **only a
 * sentence** — there is no "move it into every namespace" button.
 *
 * Copying one base value into N namespace files unchanged is a no-op that
 * `findPromotions` would immediately offer to undo (every namespace now sets it
 * identically), so the two finders would sit there passing the same value back
 * and forth. The point is not where the value is written; it is that each
 * environment needs a *different* one, and nothing here can guess what prod's
 * tag or dev's hostname should be. So it says what it sees and gets out of the
 * way.
 */
export type EnvSpecific = {
  releaseId: string;
  releaseName: string;
  /** The base values at those paths. */
  values: Values;
  /** `image.tag`, `route.host` — the paths, for the sentence on screen. */
  paths: string[];
  /** The namespaces still taking base's value, i.e. the ones this is about. */
  namespaces: string[];
};

/**
 * Values that belong to an environment rather than to a microservice.
 *
 * Hand-listed on purpose. "Looks like a hostname" is a guess, and a wrong nag
 * on a value that genuinely belongs in base teaches people to ignore the row —
 * which costs more than the rows it would have added. Add a path here when a
 * real tree proves it, not because it might apply.
 *
 * - `image.tag` / `image.digest` — every environment runs its own build; one
 *   tag in base is what makes a promotion to prod a base-file edit.
 * - `nameOverride` / `fullnameOverride` — the object names in the cluster, and
 *   the usual reason a release is named `checkout-dev` in one place.
 * - `replicaCount` — dev does not need prod's pod count.
 * - `ingress.hosts` / `route.host` — a hostname belongs to one cluster's
 *   domain, and base has no cluster.
 */
const ENV_SPECIFIC_PATHS = [
  "image.tag",
  "image.digest",
  "nameOverride",
  "fullnameOverride",
  "replicaCount",
  "ingress.hosts",
  "route.host",
];

/** One dotted path out of a document, or `undefined` if no layer of it is there. */
export function atPath(doc: Values, path: string): unknown {
  return path.split(".").reduce<unknown>((at, key) => (isPlainObject(at) ? at[key] : undefined), doc);
}

/** The same path put back into a fresh document. */
function putPath(doc: Values, path: string, value: unknown): void {
  const keys = path.split(".");
  const leaf = keys.pop() as string;
  let at = doc;
  for (const key of keys) at = (at[key] = isPlainObject(at[key]) ? (at[key] as Values) : {}) as Values;
  at[leaf] = value;
}

/**
 * What base says that each namespace probably ought to say for itself.
 *
 * Only values base **actually sets** — an unset path is not a recommendation,
 * it is silence. And only while some namespace is still taking base's answer: a
 * value every namespace already overrides is doing no harm sitting in base as
 * the fallback, and nagging about it would be nagging about a solved problem.
 */
export function findEnvSpecific(tree: ArgocdTree): EnvSpecific[] {
  const namespaces = tree.namespaces.filter((n) => n.name.trim());
  if (!namespaces.length) return [];

  const out: EnvSpecific[] = [];
  for (const release of tree.releases) {
    const base = buildValues(release.features, release.extraValues);
    const overrides = namespaces.map((ns) => {
      const entry = ns.releases.find((e) => e.release === release.id);
      return entry ? buildValues(entry.features, entry.extraValues) : {};
    });

    const paths: string[] = [];
    const values: Values = {};
    const taking = new Set<string>();
    for (const path of ENV_SPECIFIC_PATHS) {
      const value = atPath(base, path);
      if (value === undefined) continue;
      const plain = namespaces.filter((_, i) => atPath(overrides[i], path) === undefined);
      if (!plain.length) continue;
      paths.push(path);
      putPath(values, path, value);
      plain.forEach((ns) => taking.add(ns.name));
    }
    if (paths.length)
      out.push({
        releaseId: release.id,
        releaseName: release.name.trim() || "unnamed",
        values,
        paths,
        // In the tree's own order, not the order the paths happened to add
        // them — the sentence lists namespaces, not findings.
        namespaces: namespaces.filter((n) => taking.has(n.name)).map((n) => n.name),
      });
  }
  return out;
}
