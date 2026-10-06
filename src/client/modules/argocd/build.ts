import { BY_ID, FEATURES, MORE_KEY, orderKeys } from "./catalog";
import { deepMerge, isPlainObject } from "./values";
import { clean, parseHelm } from "./yaml";
import type { FeatureState } from "./catalog";
import type { Values } from "./values";

/**
 * Catalog state -> one values document.
 *
 * `extraValues` is merged last and wins, because it is both the escape hatch
 * for what the catalog does not model and where an import's unrecognised keys
 * land — a key the form cannot show must still reach the file.
 */
export function buildValues(features: Record<string, FeatureState>, extraValues?: string): Values {
  let doc: Values = {};
  FEATURES.forEach((spec) => {
    const state = features[spec.id];
    if (!state?.on) return;
    let fragment: Values | null = null;
    try {
      fragment = spec.emit(state.v ?? {});
    } catch {
      // A half-typed field must not blank the whole preview.
      fragment = null;
    }
    // A field left empty must not reach the file as `key: ""` / `[]` / `null`.
    if (fragment) doc = deepMerge(doc, clean(fragment));
    // The feature's "Other settings" — what its fields cannot say, merged over them.
    const more = parseValues(state.v?.[MORE_KEY] as string | undefined);
    if (more) doc = deepMerge(doc, more);
  });
  const extra = parseValues(extraValues);
  if (extra) doc = deepMerge(doc, extra);
  return orderKeys(doc);
}

/**
 * Parsed fragments by text. `buildValues` runs for every microservice in every
 * namespace on every keystroke and parses each one's "Other settings" and extra
 * values each time — the same few texts, over and over, and the single biggest
 * cost of typing in a large tree. A copy is handed out, so a caller that
 * changes what it got cannot change the next caller's answer.
 * ponytail: cleared wholesale past 4000 entries.
 */
const parsed = new Map<string, Values | null>();

/** A YAML fragment as an object, or null for empty/unparseable text. */
export function parseValues(text: string | undefined): Values | null {
  if (!text?.trim()) return null;
  let doc = parsed.get(text);
  if (doc === undefined) {
    // Read the way Helm reads a values file — see `parseHelm`.
    const read = parseHelm(text).doc;
    doc = isPlainObject(read) ? read : null;
    if (parsed.size > 4000) parsed.clear();
    parsed.set(text, doc);
  }
  return doc && structuredClone(doc);
}

/** Whether `extraValues` is text the writer will silently drop — the editor says so. */
export function extraValuesError(text: string | undefined): string | null {
  if (!text?.trim()) return null;
  const { doc, error } = parseHelm(text);
  if (error) return error;
  if (doc !== null && !isPlainObject(doc)) return "Extra values must be a YAML mapping, not a list or a scalar.";
  return null;
}

/** Which feature owns a top-level values key — used to route an import. */
export const OWNER_OF_KEY: Record<string, string> = Object.fromEntries(
  FEATURES.flatMap((f) => f.keys.map((k) => [k, f.id]))
);

export { BY_ID };
