import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { buildTree } from "./tree";
import { importTree } from "./importTree";
import type { ArgocdTree } from "../../../server/types";

const on = (v: Record<string, unknown>) => ({ on: true, v });

/** The same fixture `tree.test.ts` uses — two releases, one namespace overriding both. */
function tree(overrides: Partial<ArgocdTree> = {}): ArgocdTree {
  return {
    id: "AG-0001",
    name: "Test tree",
    chart: {
      repoUrl: "https://github.com/devops-ezrahi/universal-chart.git",
      path: ".",
      appsetPath: "ms-applicationSet",
      revision: "main",
    },
    values: { repoUrl: "https://git.example.com/gitops/values.git", revision: "main", path: "" },
    rootAppName: "platform-root",
    releases: [
      {
        id: "r1",
        name: "api-gateway",
        features: {
          identity: on({ nameOverride: "api-gateway" }),
          workload: on({ type: "deployment" }),
          image: on({ repository: "registry/api-gateway", tag: "1.0.0" }),
          replicas: on({ replicaCount: 2 }),
        },
      },
      {
        id: "r2",
        name: "storefront",
        features: {
          identity: on({ nameOverride: "storefront" }),
          workload: on({ type: "deployment" }),
          image: on({ repository: "registry/storefront", tag: "2.0.0" }),
          replicas: on({ replicaCount: 2 }),
        },
      },
    ],
    namespaces: [
      {
        name: "shop-web",
        releases: [
          { release: "r1", features: { image: on({ tag: "1.4.2" }) } },
          { release: "r2", features: { image: on({ tag: "9.9.9" }) } },
        ],
      },
    ],
    createdBy: "alex",
    createdByName: "Alex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The generated files as `{path: parsed document}` — the comparison the round trip is about. */
function docs(files: { path: string; text: string }[]): Record<string, unknown> {
  return Object.fromEntries(files.map((f) => [f.path, parseYaml(f.text)]));
}

/** Round-trip a tree through its own files and back. */
function roundTrip(t: ArgocdTree) {
  const files = buildTree(t);
  const recovered = importTree(files);
  const again = buildTree({
    ...t,
    ...(recovered.chart ? { chart: recovered.chart } : {}),
    ...(recovered.values ? { values: recovered.values } : {}),
    rootAppName: recovered.rootAppName || t.rootAppName,
    releases: recovered.releases,
    namespaces: recovered.namespaces,
  });
  return { files, recovered, again };
}

describe("importTree", () => {
  it("round-trips a generated tree — same paths, same documents", () => {
    const { files, again } = roundTrip(tree());
    expect(again.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort());
    expect(docs(again)).toEqual(docs(files));
  });

  it("round-trips the withoutClaimed case, where a shared override cannot go in ns defaults", () => {
    // Both releases pin the same tag, but base claims image.tag — so it stays in
    // each release's own override file. This is the case the reconstruction
    // could plausibly get wrong.
    const t = tree({
      namespaces: [
        {
          name: "shop-web",
          releases: [
            { release: "r1", features: { image: on({ tag: "7.7.7" }) } },
            { release: "r2", features: { image: on({ tag: "7.7.7" }) } },
          ],
        },
      ],
    });
    const { files, again, recovered } = roundTrip(t);
    expect(docs(again)).toEqual(docs(files));
    expect(recovered.namespaces[0].releases).toHaveLength(2);
  });

  it("round-trips a shared override that DOES reach <ns>/defaults.yaml", () => {
    // replicaCount is claimed by base too, so use a key base does not set: both
    // releases get the same resources block, which commonSubtree promotes.
    const t = tree({
      namespaces: [
        {
          name: "shop-web",
          releases: [
            { release: "r1", features: { resources: on({ rcpu: "100m", rmem: "128Mi" }) } },
            { release: "r2", features: { resources: on({ rcpu: "100m", rmem: "128Mi" }) } },
          ],
        },
      ],
    });
    const { files, again } = roundTrip(t);
    // The value really did get promoted — otherwise this test proves nothing.
    expect(parseYaml(files.find((f) => f.path === "shop-web/defaults.yaml")!.text)).not.toEqual({});
    expect(docs(again)).toEqual(docs(files));
  });

  it("names releases from the file, or from nameOverride when the chart sets one", () => {
    const { recovered } = roundTrip(tree());
    // These carry nameOverride, so the real name survives; without one the slug
    // is all the name there is.
    expect(recovered.releases.map((r) => r.name).sort()).toEqual(["api-gateway", "storefront"]);
  });

  it("carries no namespace entry for a release that overrides nothing", () => {
    const t = tree({
      namespaces: [{ name: "shop-web", releases: [{ release: "r1", features: { image: on({ tag: "1.4.2" }) } }] }],
    });
    const { recovered, files, again } = roundTrip(t);
    // storefront gets an (empty) values file so it stays in the fan-out, but no
    // draft entry — a phantom override on the card is worse than nothing.
    expect(files.some((f) => f.path === "shop-web/values/storefront.yaml")).toBe(true);
    expect(recovered.namespaces[0].releases).toHaveLength(1);
    expect(docs(again)).toEqual(docs(files));
  });

  it("recovers both repositories and the root app name from root-applicationSet.yaml", () => {
    const { recovered } = roundTrip(tree());
    expect(recovered.values).toEqual({
      repoUrl: "https://git.example.com/gitops/values.git",
      revision: "main",
      path: "",
    });
    expect(recovered.chart).toEqual({
      repoUrl: "https://github.com/devops-ezrahi/universal-chart.git",
      path: ".",
      appsetPath: "ms-applicationSet",
      revision: "main",
    });
    expect(recovered.rootAppName).toBe("platform-root");
  });

  it("recovers values.path when the tree lives in a subdirectory", () => {
    const t = tree({ values: { repoUrl: "https://git/values.git", revision: "main", path: "apps" } });
    const { recovered, files, again } = roundTrip(t);
    expect(recovered.values?.path).toBe("apps");
    expect(docs(again)).toEqual(docs(files));
  });

  it("keeps a key the catalog cannot model, and says so", () => {
    const t = tree({
      namespaces: [
        {
          name: "shop-web",
          releases: [{ release: "r1", features: {}, extraValues: "somethingCustom:\n  deep: yes\n" }],
        },
      ],
    });
    const { recovered, files, again } = roundTrip(t);
    expect(recovered.namespaces[0].releases[0].extraValues).toContain("somethingCustom");
    expect(recovered.warnings.some((w) => w.includes("somethingCustom"))).toBe(true);
    expect(docs(again)).toEqual(docs(files));
  });

  it("names a file that is not part of the layout instead of dropping it", () => {
    const files = [...buildTree(tree()), { path: "README.yaml", text: "hello: world\n" }];
    const recovered = importTree(files);
    expect(recovered.warnings.some((w) => w.startsWith("README.yaml:"))).toBe(true);
  });

  it("says so when the repo is not a values tree at all", () => {
    const recovered = importTree([{ path: "Chart.yaml", text: "name: something\n" }]);
    expect(recovered.releases).toEqual([]);
    expect(recovered.warnings.some((w) => w.includes("base/*.yaml"))).toBe(true);
  });
});
