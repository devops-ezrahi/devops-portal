import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { buildTree } from "./tree";
import type { ArgocdTree } from "../../../server/types";

const on = (v: Record<string, unknown>) => ({ on: true, v });

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

const at = (files: ReturnType<typeof buildTree>, path: string) => files.find((f) => f.path === path)!;
const doc = (files: ReturnType<typeof buildTree>, path: string) => parseYaml(at(files, path).text) as Record<string, any>;

describe("buildTree", () => {
  it("writes the gitops-factory layout: base/ and per-namespace values, no root Application/ApplicationSet", () => {
    expect(buildTree(tree()).map((f) => f.path)).toEqual([
      "base/api-gateway.yaml",
      "base/storefront.yaml",
      "shop-web/defaults.yaml",
      "shop-web/values/api-gateway.yaml",
      "shop-web/values/storefront.yaml",
    ]);
  });

  it("writes a base file whole — no tree-root defaults layer applies it back", () => {
    // A global defaults.yaml would be subtracted from every base file and then
    // read by nobody: the chart's chain starts at <ns>/defaults.yaml.
    expect(doc(buildTree(tree()), "base/api-gateway.yaml")).toEqual({
      nameOverride: "api-gateway",
      workload: { type: "deployment" },
      image: { repository: "registry/api-gateway", tag: "1.0.0" },
      replicaCount: 2,
    });
  });

  it("keeps a namespace file to what actually differs", () => {
    const files = buildTree(tree());
    expect(doc(files, "shop-web/values/api-gateway.yaml")).toEqual({ image: { tag: "1.4.2" } });
  });

  it("writes an empty layer as {} — a valueFiles entry that does not exist fails the render", () => {
    const files = buildTree(tree());
    expect(at(files, "shop-web/defaults.yaml").text).toContain("\n{}\n");
    expect(doc(files, "shop-web/defaults.yaml")).toEqual({});
  });

  it("leaves a shared namespace override out of <ns>/defaults.yaml when a base file claims the path", () => {
    // Both releases pin the same tag in this namespace, so it is "common" — but
    // base/*.yaml sets image.tag too, and base merges after namespace defaults,
    // so promoting it there would have no effect at all.
    const files = buildTree(
      tree({
        namespaces: [
          {
            name: "shop-web",
            releases: [
              { release: "r1", features: { image: on({ tag: "7.7.7" }) } },
              { release: "r2", features: { image: on({ tag: "7.7.7" }) } },
            ],
          },
        ],
      })
    );
    expect(doc(files, "shop-web/defaults.yaml")).toEqual({});
    expect(doc(files, "shop-web/values/api-gateway.yaml")).toEqual({ image: { tag: "7.7.7" } });
  });

  it("puts every release in every namespace's fan-out, overridden or not", () => {
    // A namespace runs the whole tree; an entry only carries overrides. The
    // ApplicationSet globs <ns>/values/*.yaml, so a release without a file there
    // is a release that does not deploy.
    const files = buildTree(
      tree({ namespaces: [{ name: "shop-web", releases: [{ release: "r1", features: { image: on({ tag: "1.4.2" }) } }] }] })
    );
    expect(doc(files, "shop-web/values/storefront.yaml")).toEqual({});
  });
});

describe("a namespace's defaults", () => {
  const releases = [
    { id: "r1", name: "api-gateway", features: { workload: on({ type: "deployment" }), image: on({ repository: "r/gw", tag: "1.0.0" }) } },
    { id: "r2", name: "storefront", features: { workload: on({ type: "deployment" }), image: on({ repository: "r/sf" }) } },
  ];

  const fileAt = (files: { path: string; text: string }[], path: string) =>
    parseYaml(files.find((f) => f.path === path)!.text);

  it("writes exactly what that namespace set, into its own defaults.yaml only", () => {
    const files = buildTree(
      tree({
        releases,
        namespaces: [
          { name: "shop-dev", releases: [] },
          { name: "shop-prod", defaults: { features: { podmeta: on({ podLabels: [{ k: "env", v: "prod" }] }) } }, releases: [] },
        ],
      })
    );
    expect(fileAt(files, "shop-prod/defaults.yaml").podLabels).toEqual({ env: "prod" });
    expect(fileAt(files, "shop-dev/defaults.yaml")).toEqual({});
    expect(fileAt(files, "base/api-gateway.yaml").podLabels).toBeUndefined();
    // No tree-root defaults: base is the same in every namespace and has none.
    expect(files.some((f) => f.path === "defaults.yaml")).toBe(false);
  });

  it("promotes nothing on its own — a value every microservice shares stays where it was set", () => {
    const files = buildTree(
      tree({
        releases,
        namespaces: [
          {
            name: "shop-dev",
            releases: [
              { release: "r1", features: { replicas: on({ replicaCount: 3 }) } },
              { release: "r2", features: { replicas: on({ replicaCount: 3 }) } },
            ],
          },
        ],
      })
    );
    expect(fileAt(files, "shop-dev/defaults.yaml")).toEqual({});
    expect(fileAt(files, "shop-dev/values/api-gateway.yaml").replicaCount).toBe(3);
    expect(fileAt(files, "shop-dev/values/storefront.yaml").replicaCount).toBe(3);
  });

  it("layers over base — a monorepo tag reaches a microservice whose base has its own", () => {
    const files = buildTree(
      tree({
        releases,
        namespaces: [
          {
            name: "shop-prod",
            defaults: { features: { image: on({ tag: "7.0.0" }) } },
            releases: [{ release: "r1", features: { image: on({ tag: "7.0.0" }) } }],
          },
        ],
      })
    );
    expect(fileAt(files, "shop-prod/defaults.yaml").image).toEqual({ tag: "7.0.0" });
    // Restating 7.0.0 in api-gateway's own file is a no-op, but it was set
    // there — so it stays. Dropping set values is what made a namespace file's
    // image.repository vanish from a repo nobody had edited.
    expect(fileAt(files, "shop-prod/values/api-gateway.yaml")).toEqual({ image: { tag: "7.0.0" } });
  });

  it("keeps a namespace value equal to base, and drops only the chart's own defaults", () => {
    const files = buildTree(
      tree({
        releases: [
          {
            id: "r1",
            name: "api-gateway",
            features: {
              image: on({ repository: "registry/api" }),
              service: on({ enabled: true, type: "ClusterIP", ports: [{ name: "http", port: 80 }] }),
            },
          },
        ],
        namespaces: [
          {
            name: "shop-prod",
            releases: [
              {
                release: "r1",
                features: {
                  image: on({ repository: "registry/api", tag: "2.0" }),
                  // Ticking Service on here writes enabled/type — chart defaults base also says.
                  service: on({ enabled: true, type: "ClusterIP", annotations: [{ k: "a", v: "b" }] }),
                },
              },
            ],
          },
        ],
      })
    );
    expect(fileAt(files, "shop-prod/values/api-gateway.yaml")).toEqual({
      image: { repository: "registry/api", tag: "2.0" },
      service: { annotations: { a: "b" } },
    });
  });
});
