import { parse as parseYaml } from "yaml";
import { BY_ID, FEATURES, orderKeys } from "./catalog";
import { deepMerge, isPlainObject } from "./values";
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
    if (fragment) doc = deepMerge(doc, fragment);
  });
  const extra = parseValues(extraValues);
  if (extra) doc = deepMerge(doc, extra);
  return orderKeys(doc);
}

/** A YAML fragment as an object, or null for empty/unparseable text. */
export function parseValues(text: string | undefined): Values | null {
  if (!text?.trim()) return null;
  try {
    const parsed = parseYaml(text) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Whether `extraValues` is text the writer will silently drop — the editor says so. */
export function extraValuesError(text: string | undefined): string | null {
  if (!text?.trim()) return null;
  try {
    const parsed = parseYaml(text) as unknown;
    if (!isPlainObject(parsed)) return "Extra values must be a YAML mapping, not a list or a scalar.";
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0] : "Could not parse this YAML.";
  }
}

/** Which feature owns a top-level values key — used to route an import. */
export const OWNER_OF_KEY: Record<string, string> = Object.fromEntries(
  FEATURES.flatMap((f) => f.keys.map((k) => [k, f.id]))
);

export { BY_ID };
