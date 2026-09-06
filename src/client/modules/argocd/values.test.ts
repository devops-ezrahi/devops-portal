import { describe, expect, it } from "vitest";
import { commonSubtree, deepMerge, subtractDefaults } from "./values";

/**
 * These are `gitops-factory/ui/core-logic.test.js`'s own assertions, carried
 * over. They exist so this logic does not drift from
 * `convert_to_universal_chart.py`'s `deep_merge` / `common_subtree` /
 * `subtract_defaults` — a tree authored in the portal and one produced by the
 * converter land in the same repo and are merged by the same ApplicationSet.
 */
describe("layer merge/diff", () => {
  const d1 = { resources: { requests: { cpu: "100m" }, limits: { cpu: "500m" } }, replicas: 2 };
  const d2 = { resources: { requests: { cpu: "100m" }, limits: { cpu: "999m" } }, replicas: 3 };
  const d3 = { resources: { requests: { cpu: "100m" }, limits: { cpu: "999m" } }, replicas: 1 };

  it("merges objects recursively and replaces lists wholesale", () => {
    expect(deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 99 }, e: 5 })).toEqual({ a: 1, b: { c: 99, d: 3 }, e: 5 });
    expect(deepMerge({ a: [1, 2] }, { a: [9] })).toEqual({ a: [9] });
  });

  it("keeps only what is identical across every document", () => {
    expect(commonSubtree([d1, d2, d3])).toEqual({ resources: { requests: { cpu: "100m" } } });
  });

  it("subtracts a lower layer recursively", () => {
    expect(subtractDefaults(d1, { resources: { requests: { cpu: "100m" } } })).toEqual({
      resources: { limits: { cpu: "500m" } },
      replicas: 2,
    });
  });

  it("round-trips: merge(common, subtract(doc, common)) is the document", () => {
    const common = commonSubtree([d1, d2, d3]);
    for (const d of [d1, d2, d3]) expect(deepMerge(common, subtractDefaults(d, common))).toEqual(d);
  });

  it("promotes nothing out of fewer than two documents", () => {
    expect(commonSubtree([])).toEqual({});
    expect(commonSubtree([d1])).toEqual({});
    expect(subtractDefaults({ a: 1 }, {})).toEqual({ a: 1 });
  });
});
