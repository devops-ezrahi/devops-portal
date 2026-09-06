import { parseAllDocuments } from "yaml";
import { BY_ID, FEATURES, isRecord, nz, pairsOf } from "./catalog";
import { buildValues, parseValues } from "./build";
import { subtractDefaults } from "./values";
import { toYaml } from "./yaml";
import type { FeatureState, FieldSpec } from "./catalog";
import type { Values } from "./values";

/**
 * A pasted `values.yaml` back into catalog state.
 *
 * **Anything the catalog cannot represent is kept, not dropped**: whatever a
 * re-emit of the imported state fails to reproduce is written into
 * `extraValues` (which is merged last) and named in `warnings`. That is
 * `jenkinsfile/parse.ts`'s rule — a section that vanishes without a word is
 * worse than one re-added by hand — and here it is load-bearing twice over,
 * since these values are about to be deployed.
 */
export type ImportResult = {
  features: Record<string, FeatureState>;
  extraValues: string;
  warnings: string[];
};

function at(doc: Values, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), doc);
}

/** A field's stored shape from what the document holds at its path. */
function fieldValue(spec: FieldSpec, raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  switch (spec.kind) {
    case "boolean":
      return !!raw;
    case "kv":
      return pairsOf(raw);
    case "rows":
      return Array.isArray(raw) ? raw : undefined;
    default:
      return typeof raw === "object" ? undefined : String(raw);
  }
}

export function importValues(text: string): ImportResult {
  const docs = parseAllDocuments(text);
  const warnings: string[] = [];
  if (docs.length > 1) {
    // A values file is one document. Several usually means raw manifests were
    // pasted, which is the converter's job, not this builder's.
    warnings.push(`Only the first of ${docs.length} YAML documents was read — this reads a values.yaml, not raw manifests.`);
  }
  const first = docs[0];
  first?.errors.forEach((err) => warnings.push(err.message));
  const doc = parseValues(text.split(/^---\s*$/m)[0]);
  if (!doc) return { features: {}, extraValues: "", warnings: [...warnings, "Nothing to import: that is not a YAML mapping."] };

  const features: Record<string, FeatureState> = {};
  FEATURES.forEach((spec) => {
    if (!spec.keys.some((k) => k in doc)) return;
    const v = spec.load
      ? spec.load(doc)
      : Object.fromEntries(
          spec.fields
            .filter((f) => f.path)
            .map((f) => [f.key, fieldValue(f, at(doc, f.path!))])
            .filter(([, value]) => value !== undefined)
        );
    features[spec.id] = { on: true, v };
  });

  // What a re-emit does not reproduce is what the catalog could not hold. Both
  // sides are compared as parsed YAML, since a feature that writes a raw block
  // holds text where the document holds a map.
  const emitted = parseValues(toYaml(buildValues(features))) ?? {};
  const leftovers = subtractDefaults(doc, emitted);
  const extraValues = Object.keys(leftovers).length ? `${toYaml(leftovers)}\n` : "";
  Object.keys(leftovers).forEach((key) => {
    const owner = FEATURES.find((f) => f.keys.includes(key));
    warnings.push(
      owner
        ? `${key}: kept as extra values — more than the ${owner.name} form can show.`
        : `${key}: kept as extra values — the builder does not model this key.`
    );
  });

  return { features, extraValues, warnings };
}

/** The name a release should take from an imported document, if it names itself. */
export function releaseNameFrom(text: string): string {
  const doc = parseValues(text);
  const name = doc?.nameOverride ?? doc?.fullnameOverride;
  return nz(name) ? String(name) : "";
}

export { BY_ID };
