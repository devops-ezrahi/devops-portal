import { describe, expect, it } from "vitest";
import { applyDefaultsDemotion, applyDemotion, applyPromotion, findEnvSpecific, findPromotions, removeShadowed } from "./promote";
import { buildValues } from "./build";
import { deepMerge, shadowing } from "./values";
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

/** Two namespaces that both set the same pull policy, and disagree on replicas. */
const shared = () =>
  tree({
    namespaces: [
      { name: "dev", releases: [{ release: "r1", features: { image: on({ pullPolicy: "Always" }), replicas: on({ replicaCount: "1" }) } }] },
      { name: "prod", releases: [{ release: "r1", features: { image: on({ pullPolicy: "Always" }), replicas: on({ replicaCount: "6" }) } }] },
    ],
  });

describe("findPromotions", () => {
  it("finds what every namespace sets identically, and leaves what they disagree on", () => {
    const found = findPromotions(shared());
    expect(found).toHaveLength(1);
    expect(found[0].releaseName).toBe("checkout");
    expect(found[0].paths).toEqual(["image.pullPolicy"]);
    expect(found[0].namespaces).toEqual(["dev", "prod"]);
  });

  it("never offers a value findEnvSpecific keeps per namespace, even when every namespace agrees", () => {
    // Six namespaces on postgres:16.3 is not a reason to put the tag back in
    // base — offering it made this and findEnvSpecific undo each other.
    const t = tree({
      namespaces: ["dev", "prod"].map((name) => ({
        name,
        releases: [{ release: "r1", features: { image: on({ tag: "16.3" }), replicas: on({ replicaCount: "2" }) } }],
      })),
    });
    expect(findPromotions(t)).toEqual([]);
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
    t.releases[0].features.image = on({ repository: "shop/checkout", tag: "1.0.0", pullPolicy: "Always" });
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

    // Base gained the pull policy...
    expect(buildValues(after.releases[0].features, after.releases[0].extraValues)).toMatchObject({
      image: { repository: "shop/checkout", tag: "1.0.0", pullPolicy: "Always" },
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

describe("applyDemotion", () => {
  const twoCopies = () =>
    tree({
      releases: [
        { id: "r1", name: "checkout", features: { image: on({ repository: "shop/checkout" }), replicas: on({ replicaCount: "2" }) } },
      ],
      namespaces: [
        { name: "dev", releases: [] },
        { name: "prod", releases: [{ release: "r1", features: { replicas: on({ replicaCount: "6" }) } }] },
      ],
    });
  const docIn = (t: ArgocdTree, ns: number) => {
    const e = t.namespaces[ns].releases.find((x) => x.release === "r1");
    return e ? buildValues(e.features, e.extraValues) : {};
  };

  it("takes the value out of base and gives each namespace still taking it its own copy", () => {
    const after = applyDemotion(twoCopies(), "r1", { replicaCount: 6 });
    expect(buildValues(after.releases[0].features, after.releases[0].extraValues).replicaCount).toBeUndefined();
    expect(docIn(after, 0).replicaCount).toBe(2);
    expect(docIn(after, 1).replicaCount).toBe(6);
  });

  it("leaves what every namespace deploys unchanged", () => {
    const before = twoCopies();
    const after = applyDemotion(before, "r1", { replicaCount: 6 });
    const deployed = (t: ArgocdTree, i: number) =>
      JSON.stringify(deepMerge(buildValues(t.releases[0].features, t.releases[0].extraValues), docIn(t, i)));
    expect(deployed(after, 0)).toBe(deployed(before, 0));
    expect(deployed(after, 1)).toBe(deployed(before, 1));
  });
});

describe("applyDefaultsDemotion", () => {
  const withDefault = () =>
    tree({
      releases: [
        { id: "r1", name: "checkout", features: {} },
        { id: "r2", name: "cart", features: { replicas: on({ replicaCount: "1" }) } },
        { id: "r3", name: "search", features: {} },
      ],
      namespaces: [
        {
          name: "prod",
          defaults: { features: { replicas: on({ replicaCount: "3" }) } },
          releases: [
            { release: "r1", features: { replicas: on({ replicaCount: "6" }) } },
            { release: "r3", features: { replicas: on({ replicaCount: "4" }) } },
          ],
        },
      ],
    });

  it("takes the value out of the defaults, and nothing in the namespace deploys differently", () => {
    const before = withDefault();
    const after = applyDefaultsDemotion(before, 0, "r1", { replicaCount: 6 });
    const ns = after.namespaces[0];
    expect(buildValues(ns.defaults!.features, ns.defaults!.extraValues).replicaCount).toBeUndefined();
    const deployed = (t: ArgocdTree, id: string) => {
      const r = t.releases.find((x) => x.id === id)!;
      const e = t.namespaces[0].releases.find((x) => x.release === id);
      const d = t.namespaces[0].defaults;
      return deepMerge(
        deepMerge(buildValues(r.features, r.extraValues), buildValues(d?.features ?? {}, d?.extraValues)),
        e ? buildValues(e.features, e.extraValues) : {}
      ).replicaCount;
    };
    // cart took the default over its base's 1, so it gets a copy of the 3;
    // search already said 4 and keeps it.
    expect(["r1", "r2", "r3"].map((id) => deployed(after, id))).toEqual(["r1", "r2", "r3"].map((id) => deployed(before, id)));
    expect(ns.releases.find((e) => e.release === "r3")!.features.replicas.v.replicaCount).toBe("4");
  });
});

describe("findEnvSpecific", () => {
  /** Base pins a tag and a hostname; nothing overrides either yet. */
  const pinned = () => {
    const t = tree({
      namespaces: [
        { name: "dev", releases: [] },
        { name: "prod", releases: [{ release: "r1", features: { replicas: on({ replicaCount: "6" }) } }] },
      ],
    });
    t.releases[0].features.route = on({ enabled: true, host: "checkout.apps.example.com" });
    return t;
  };

  it("names the base values only an environment can answer", () => {
    const found = findEnvSpecific(pinned());
    expect(found).toHaveLength(1);
    expect(found[0].releaseName).toBe("checkout");
    // `image.repository` is the microservice's own — it is not on the list.
    expect(found[0].paths).toEqual(["image.tag", "route.host"]);
    expect(found[0].namespaces).toEqual(["dev", "prod"]);
    expect(found[0].values).toEqual({ image: { tag: "1.0.0" }, route: { host: "checkout.apps.example.com" } });
  });

  it("says nothing about a path base does not set", () => {
    const t = pinned();
    t.releases[0].features.image = on({ repository: "shop/checkout" });
    expect(findEnvSpecific(t)[0].paths).toEqual(["route.host"]);
  });

  it("says nothing once every namespace answers it for itself", () => {
    // Base is then just the fallback nothing reaches, which is not a problem.
    const t = pinned();
    t.namespaces.forEach((ns) => {
      ns.releases = [{ release: "r1", features: { image: on({ tag: "9.9.9" }), route: on({ host: "x.example.com" }) } }];
    });
    expect(findEnvSpecific(t)).toEqual([]);
  });

  it("still counts the namespaces that have not, when one has", () => {
    const t = pinned();
    t.namespaces[0].releases = [{ release: "r1", features: { image: on({ tag: "9.9.9" }) } }];
    const found = findEnvSpecific(t);
    expect(found[0].paths).toEqual(["image.tag", "route.host"]);
    // dev pinned its own tag, but both are still taking base's route host.
    expect(found[0].namespaces).toEqual(["dev", "prod"]);
  });

  it("names each path's own namespaces, not every namespace any path has", () => {
    // The first namespace pins its own tag but still takes base's route host —
    // it must be named under the host only, never under the tag.
    const t = pinned();
    const first = t.namespaces[0].name;
    t.namespaces[0].releases = [{ release: "r1", features: { image: on({ tag: "9.9.9" }) } }];
    const found = findEnvSpecific(t)[0];
    expect(found.takenBy["image.tag"]).not.toContain(first);
    expect(found.takenBy["route.host"]).toContain(first);
  });

  it("counts a namespace's defaults as that namespace answering for itself", () => {
    // A monorepo tag set once for the namespace: base's tag is no longer taken there.
    const t = pinned();
    const first = t.namespaces[0].name;
    t.namespaces[0].defaults = { features: { image: on({ tag: "7.0.0" }) } };
    expect(findEnvSpecific(t)[0].takenBy["image.tag"] ?? []).not.toContain(first);
  });

  it("needs a namespace to recommend anything into", () => {
    const t = pinned();
    t.namespaces = [];
    expect(findEnvSpecific(t)).toEqual([]);
  });
});

describe("removeShadowed", () => {
  it("drops the overridden repository and keeps the namespace's own tag", () => {
    const below = { image: { repository: "registry/base", tag: "1.0" } };
    const features = { image: { on: true, v: { repository: "registry/prod", tag: "2.0" } } };
    // tag differs too, so both shadow — but a tag base lacks would stay:
    const next = removeShadowed(features, "image", { image: { repository: "registry/base" } });
    expect(buildValues(next)).toEqual({ image: { tag: "2.0" } });
    expect(buildValues(removeShadowed(features, "image", below))).toEqual({});
  });

  it("treats env vars one by one: only a variable base also sets differently goes", () => {
    const row = (name: string, value: string) => ({ name, kind: "value", value });
    const below = buildValues({ env: { on: true, v: { items: [row("LOG_LEVEL", "info"), row("TZ", "UTC")] } } });
    const features = { env: { on: true, v: { items: [row("LOG_LEVEL", "debug"), row("MODE", "production")] } } };

    // MODE is only here — not an override; LOG_LEVEL is.
    expect(Object.keys(shadowing(buildValues(features), below))).toEqual(["env"]);
    expect(buildValues(removeShadowed(features, "env", below))).toEqual({ env: { MODE: { value: "production" } } });
    expect(shadowing(buildValues({ env: { on: true, v: { items: [row("MODE", "production")] } } }), below)).toEqual({});
  });
});
