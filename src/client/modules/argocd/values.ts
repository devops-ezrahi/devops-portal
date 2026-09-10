/**
 * Merge / diff over values documents.
 *
 * Ported from `gitops-factory/ui/core-logic.test.js`, which exists so this
 * logic does not drift from `convert_to_universal_chart.py`'s `deep_merge` /
 * `common_subtree` / `subtract_defaults` (`convert_to_universal_chart.py:2792`).
 * The layered tree only works if all three agree: a key promoted into a
 * defaults file is a key subtracted from every file below it, and Argo merges
 * the result back in the same order Helm does.
 *
 * `values.test.ts` carries that file's own assertions, so a change on either
 * side shows up as a failing test rather than a values file that quietly
 * disagrees with the converter's.
 */

export type Values = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is Values =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/* Readers over a built document. Shared by `checks.ts` and `resources.ts`,
   which both answer questions about a merged values doc rather than about
   catalog state. */

/** A branch of the document, or an empty one — so `obj(doc.x).y` never throws. */
export const obj = (v: unknown): Values => (isPlainObject(v) ? v : {});

/**
 * Configured, and not turned off. An absent key is not "enabled by default"
 * here: this only speaks about what the document actually says.
 */
export const enabled = (v: unknown): boolean =>
  isPlainObject(v) && Object.keys(v).length > 0 && v.enabled !== false;

/** Written, whatever it says. */
export const present = (v: unknown): boolean => isPlainObject(v) && Object.keys(v).length > 0;

export const list = (v: unknown): Values[] => (Array.isArray(v) ? (v as Values[]) : []);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPlainObject(a) && isPlainObject(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  return false;
}

/** Override wins; objects merge recursively, lists replace wholesale — Helm's own rule. */
export function deepMerge(base: Values | undefined, override: Values | undefined): Values {
  const result: Values = { ...(base ?? {}) };
  for (const [key, val] of Object.entries(override ?? {})) {
    if (isPlainObject(result[key]) && isPlainObject(val)) result[key] = deepMerge(result[key] as Values, val);
    else result[key] = val;
  }
  return result;
}

/** What is byte-identical across every document — the defaults.yaml layer. */
export function commonSubtree(docs: Values[]): Values {
  // One document has nothing in common with anything; promoting all of it into
  // a defaults file would empty the file it came from.
  if (docs.length < 2) return {};
  const [first, ...rest] = docs;
  const common: Values = {};
  for (const [key, val] of Object.entries(first)) {
    if (!rest.every((d) => Object.prototype.hasOwnProperty.call(d, key))) continue;
    const others = rest.map((d) => d[key]);
    if (isPlainObject(val) && others.every(isPlainObject)) {
      const sub = commonSubtree([val, ...(others as Values[])]);
      if (Object.keys(sub).length) common[key] = sub;
    } else if (others.every((o) => deepEqual(o, val))) {
      common[key] = val;
    }
  }
  return common;
}

/** The exact inverse: drop whatever a lower layer already supplies. */
export function subtractDefaults(values: Values, defaults: Values | undefined): Values {
  if (!defaults || !Object.keys(defaults).length) return values;
  const out: Values = {};
  for (const [key, val] of Object.entries(values)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      out[key] = val;
      continue;
    }
    const dval = defaults[key];
    if (isPlainObject(val) && isPlainObject(dval)) {
      const sub = subtractDefaults(val, dval);
      if (Object.keys(sub).length) out[key] = sub;
    } else if (!deepEqual(val, dval)) {
      out[key] = val;
    }
  }
  return out;
}
