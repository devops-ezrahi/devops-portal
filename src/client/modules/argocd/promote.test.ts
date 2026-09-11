import { describe, expect, it } from "vitest";
import { applyPromotion, findPromotions } from "./promote";
import { buildValues } from "./build";
import { deepMerge } from "./values";
import type { ArgocdTree } from "../../../server/types";

const on = (v: Record<string, unknown> = {}) => ({ on: true, v });

const tree = (over: Partial<ArgocdTree> = {}): ArgocdTree => ({
  id: "AG-0001",
  name: "t",
  chart: { repoUrl: "https://example.com/c.git", path: ".", appsetPath: "ms-applicationSet", revision: "main" },
  values: { repoUrl: "https://example.com/v.git", revision: "main", path: "" },
  rootAppName: "platform-root",
  releases: [{ id: "r1", name: "checkout", features: { image: on({ repository: "shop/checkout", tag: "1.0.0" }) } }],
  namespaces: [],
  createdBy: "dev",
  createdByName: "Dev",
  createdAt: "",
  updatedAt: "",
  ...over,
});

/** Two namespaces that both pin the same tag, and disagree on replicas. */
const shared = () =>
  tree({
    namespaces: [
      { name: "dev", releases: [{ release: "r1", features: { image: on({ tag: "2.0.0" }), replicas: on({ replicaCount: "1" }) } }] },
      { name: "prod", releases: [{ release: "r1", features: { image: on({ tag: "2.0.0" }), replicas: on({ replicaCount: "6" }) } }] },
    ],
  });

describe("findPromotions", () => {
  it("finds what every namespace sets identically, and leaves what they disagree on", () => {
    const found = findPromotions(shared());
    expect(found).toHaveLength(1);
    expect(found[0].releaseName).toBe("checkout");
    expect(found[0].paths).toEqual(["image.tag"]);
    expect(found[0].namespaces).toEqual(["dev", "prod"]);
  });

  it("says nothing when a namespace does not override the microservice at all", () => {
    // The silent namespace is running the base value, so promoting the other
    // two's agreement would change what it deploys.
    const t = shared();
    t.namespaces.push({ name: "staging", releases: [] });
    expect(findPromotions(t)).toEqual([]);
  });

  it("says nothing when base already carries the value", () => {
    const t = shared();
    t.releases[0].features.image = on({ repository: "shop/checkout", tag: "2.0.0" });
    expect(findPromotions(t)).toEqual([]);
  });

  it("needs more than one namespace to have an agreement at all", () => {
    const t = shared();
    t.namespaces = [t.namespaces[0]];
    expect(findPromotions(t)).toEqual([]);
  });
});

describe("applyPromotion", () => {
  it("moves the value into base and takes it out of every namespace", () => {
    const before = shared();
    const after = applyPromotion(before, findPromotions(before)[0]);

    // Base gained the tag...
    expect(buildValues(after.releases[0].features, after.releases[0].extraValues)).toMatchObject({
      image: { repository: "shop/checkout", tag: "2.0.0" },
    });
    // ...and both namespaces lost it, keeping what they actually disagree on.
    after.namespaces.forEach((ns) => {
      const doc = buildValues(ns.releases[0].features, ns.releases[0].extraValues);
      expect(doc.image).toBeUndefined();
      expect(doc.replicaCount).toBeDefined();
    });
  });

  it("leaves the deployed document unchanged — that is the whole point", () => {
    // What a namespace actually deploys is base merged with its override. A
    // promotion moves a value between those two layers, so the merge of them
    // has to come out the same both times or it is not a refactor.
    const before = shared();
    const after = applyPromotion(before, findPromotions(before)[0]);
    const deployed = (t: typeof before, i: number) => {
      const base = buildValues(t.releases[0].features, t.releases[0].extraValues);
      const over = buildValues(t.namespaces[i].releases[0].features, t.namespaces[i].releases[0].extraValues);
      // `deepMerge`, not a spread: the layering merges objects recursively, and
      // a shallow spread would replace the whole `image` block.
      return JSON.stringify(deepMerge(base, over));
    };
    expect(deployed(after, 0)).toBe(deployed(before, 0));
    expect(deployed(after, 1)).toBe(deployed(before, 1));
  });
});
