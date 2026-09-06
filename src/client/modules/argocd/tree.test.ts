import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { buildTree } from "./tree";
import type { ArgocdTree } from "../../../server/types";

const on = (v: Record<string, unknown>) => ({ on: true, v });

function tree(overrides: Partial<ArgocdTree> = {}): ArgocdTree {
  return {
    id: "AG-0001",
    name: "Test tree",
    chart: { repoUrl: "https://github.com/devops-ezrahi/universal-chart.git", path: ".", revision: "main" },
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
  it("writes the gitops-factory layout", () => {
    expect(buildTree(tree()).map((f) => f.path)).toEqual([
      "defaults.yaml",
      "base/api-gateway.yaml",
      "base/storefront.yaml",
      "shop-web/defaults.yaml",
      "shop-web/values/api-gateway.yaml",
      "shop-web/releases/api-gateway.yaml",
      "shop-web/values/storefront.yaml",
      "shop-web/releases/storefront.yaml",
      "shop-web/shop-web-applicationset.yaml",
      "root-application.yaml",
    ]);
  });

  it("promotes what every release shares into defaults.yaml and takes it out of the base files", () => {
    const files = buildTree(tree());
    expect(doc(files, "defaults.yaml")).toEqual({ workload: { type: "deployment" }, replicaCount: 2 });
    expect(doc(files, "base/api-gateway.yaml")).toEqual({
      nameOverride: "api-gateway",
      image: { repository: "registry/api-gateway", tag: "1.0.0" },
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
    // A namespace runs the whole tree; an entry only carries overrides. Leaving
    // a release out of releases/ would drop it from the ApplicationSet.
    const files = buildTree(
      tree({ namespaces: [{ name: "shop-web", releases: [{ release: "r1", features: { image: on({ tag: "1.4.2" }) } }] }] })
    );
    expect(at(files, "shop-web/releases/storefront.yaml").text).toBe("release: storefront\n");
    expect(doc(files, "shop-web/values/storefront.yaml")).toEqual({});
  });

  it("wires the ApplicationSet to the pointer files and the four layers, in order", () => {
    const set = doc(buildTree(tree()), "shop-web/shop-web-applicationset.yaml");
    expect(set.kind).toBe("ApplicationSet");
    expect(set.spec.generators[0].git.files).toEqual([{ path: "shop-web/releases/*.yaml" }]);
    expect(set.spec.template.spec.sources[0].helm.valueFiles).toEqual([
      "$values/defaults.yaml",
      "$values/shop-web/defaults.yaml",
      "$values/base/{{release}}.yaml",
      "$values/shop-web/values/{{release}}.yaml",
    ]);
    expect(set.spec.template.spec.sources[1]).toEqual({
      repoURL: "https://git.example.com/gitops/values.git",
      targetRevision: "main",
      ref: "values",
    });
    expect(set.spec.template.spec.destination.namespace).toBe("shop-web");
  });

  it("prefixes every reference when the tree lives in a subdirectory of the values repo", () => {
    const files = buildTree(tree({ values: { repoUrl: "https://git/values.git", revision: "main", path: "apps" } }));
    const set = doc(files, "shop-web/shop-web-applicationset.yaml");
    expect(set.spec.generators[0].git.files).toEqual([{ path: "apps/shop-web/releases/*.yaml" }]);
    expect(set.spec.template.spec.sources[0].helm.valueFiles[0]).toBe("$values/apps/defaults.yaml");
    expect(doc(files, "root-application.yaml").spec.source.path).toBe("apps");
  });

  it("does not prune from the root app, and cannot mistake a values file for a manifest", () => {
    const root = doc(buildTree(tree()), "root-application.yaml");
    expect(root.spec.syncPolicy.automated.prune).toBe(false);
    expect(root.spec.source.directory.exclude).toBe("{base/*,*/values/*,*/releases/*}");
  });

  it("names the pointer file's content, which is what {{release}} resolves to", () => {
    expect(at(buildTree(tree()), "shop-web/releases/api-gateway.yaml").text).toBe("release: api-gateway\n");
  });
});
