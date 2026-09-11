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
