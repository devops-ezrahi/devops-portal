import { parseAllDocuments } from "yaml";
import { BY_ID, FEATURES, MORE_KEY, isRecord, nz, pairsOf } from "./catalog";
import { buildValues, parseValues } from "./build";
import { subtractDefaults } from "./values";
import { parseHelm, toYaml } from "./yaml";
import { isPlainObject } from "./values";
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
  /** Helm could not read it (or it is not a mapping): the caller keeps the file's text verbatim. */
  unparsed?: boolean;
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

/** Every field the catalog can invert on its own — the ones with a `path`. */
function fromPaths(spec: { fields: FieldSpec[] }, doc: Values): Record<string, unknown> {
  return Object.fromEntries(
    spec.fields
      .filter((f) => f.path)
      .map((f) => [f.key, fieldValue(f, at(doc, f.path!))])
      .filter(([, value]) => value !== undefined)
  );
}

/** Whether a loaded field says anything. `false` does; an empty list does not. */
const holds = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "");

/** Chart keys the catalog does not edit but that are expected in a converted tree. */
export const CHART_PASSTHROUGH_KEYS = new Set([
  "chartLabels",
  "selectorLabels",
  "portOrder",
  "envOrder",
  "envFromOrder",
  "volumeMountOrder",
  "volumeOrder",
  "sidecarOrder",
  "initContainerOrder",
]);

export function importValues(text: string): ImportResult {
  const docs = parseAllDocuments(text);
  const warnings: string[] = [];
  if (docs.length > 1) {
    // A values file is one document. Several usually means raw manifests were
    // pasted, which is the converter's job, not this builder's.
    warnings.push(`Only the first of ${docs.length} YAML documents was read — this reads a values.yaml, not raw manifests.`);
  }
  // Read the way Helm reads it (first document, YAML 1.1 scalars, last of a
  // repeated key wins) — a file that opens with `---` used to be cut at that
  // marker and import as nothing at all.
  const { doc: parsed, error } = parseHelm(text);
  if (error)
    return { features: {}, extraValues: "", unparsed: true, warnings: [...warnings, `Cannot be read as YAML (${error}) — kept exactly as it is.`] };
  if (parsed === null) return { features: {}, extraValues: "", warnings };
  if (!isPlainObject(parsed))
    return { features: {}, extraValues: "", unparsed: true, warnings: [...warnings, "That is not a YAML mapping — kept exactly as it is."] };
  const doc: Values = parsed;

  const features: Record<string, FeatureState> = {};
  FEATURES.forEach((spec) => {
    if (!spec.keys.some((k) => k in doc)) return;
    // `load` says only what a field's `path` cannot, so it is merged *over* the
    // path-derived read rather than replacing it — volumeClaimTemplates has both
    // rows and two plain fields, and replacing dropped the plain half.
    const v = { ...fromPaths(spec, doc), ...(spec.load?.(doc) ?? {}) };
    // A feature that read nothing back would be a ticked, empty card whose real
    // content sits invisibly in `extraValues` — the one thing this module does
    // not do. Leave it off, and let the warning below be the only claim made
    // about that key.
    if (!Object.values(v).some(holds)) return;
    features[spec.id] = { on: true, v };
  });

  // What a re-emit does not reproduce is what the catalog could not hold. Both
  // sides are compared as parsed YAML, since a feature that writes a raw block
  // holds text where the document holds a map.
  const emitted = parseValues(toYaml(buildValues(features))) ?? {};
  const leftovers = subtractDefaults(doc, emitted);
  const extra: Values = {};
  Object.entries(leftovers).forEach(([key, value]) => {
    const owner = FEATURES.find((f) => f.keys.includes(key));
    // A feature that is on keeps what its fields could not hold on its own card,
    // under "Other settings" — a live Route's `serviceName`, a probe's `scheme`.
    // Only the difference goes: `buildValues` deep-merges it back over what the
    // fields emit, and a list that differs at all is already carried whole.
    if (owner && features[owner.id]) {
      const v = features[owner.id].v;
      v[MORE_KEY] = [v[MORE_KEY], toYaml({ [key]: value })].filter(Boolean).join("\n");
      return;
    }
    extra[key] = value;
    // The chart's own bookkeeping the converter writes (live labels and
    // selector, list order) — nothing to edit, and nothing lost by keeping it as
    // it is, so a pull of a converted tree does not warn on every file.
    if (!owner && CHART_PASSTHROUGH_KEYS.has(key)) return;
    warnings.push(
      owner
        ? `${key}: kept as extra values — the ${owner.name} form read nothing from it.`
        : `${key}: kept as extra values — the builder does not model this key.`
    );
  });
  const extraValues = Object.keys(extra).length ? `${toYaml(extra)}\n` : "";

  return { features, extraValues, warnings };
}

/**
 * The name a pasted values file suggests for its release: its `nameOverride`.
 * Not `fullnameOverride`, which is a workload's raw name and may be templated.
 */
export function releaseNameFrom(text: string): string {
  const name = parseValues(text)?.nameOverride;
  return nz(name) && !String(name).includes("{{") ? String(name) : "";
}

export { BY_ID };
