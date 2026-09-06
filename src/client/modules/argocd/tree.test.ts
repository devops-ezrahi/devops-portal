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
  it("writes the gitops-factory layout: base/, per-namespace values, and the two root files", () => {
    expect(buildTree(tree()).map((f) => f.path)).toEqual([
      "base/api-gateway.yaml",
      "base/storefront.yaml",
      "shop-web/defaults.yaml",
      "shop-web/values/api-gateway.yaml",
      "shop-web/values/storefront.yaml",
      "root-applicationSet.yaml",
      "root-application.yaml",
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

  it("deploys the ms-applicationSet chart once per namespace directory", () => {
    const set = doc(buildTree(tree()), "root-applicationSet.yaml");
    expect(set.kind).toBe("ApplicationSet");
    expect(set.metadata.name).toBe("platform-root-set");
    // Every top-level directory is a namespace except the ones that hold values
    // or reports.
    expect(set.spec.generators[0].git.directories).toEqual([
      { path: "*" },
      { path: "base", exclude: true },
      { path: "cluster-shared", exclude: true },
      { path: "ERRORS_ANALYSIS", exclude: true },
      { path: "report", exclude: true },
    ]);

    const source = set.spec.template.spec.sources[0];
    expect(source.path).toBe("ms-applicationSet");
    // originPath is absent: this tree is the values repo's root.
    expect(Object.fromEntries(source.helm.parameters.map((p: any) => [p.name, p.value]))).toEqual({
      namespace: "{{path.basename}}",
      originRepoURL: "https://git.example.com/gitops/values.git",
      originBranch: "main",
      project: "default",
      destinationServer: "https://kubernetes.default.svc",
      chartRepoURL: "https://github.com/devops-ezrahi/universal-chart.git",
      chartRevision: "main",
      chartPath: ".",
    });
  });

  it("prefixes every reference when the tree lives in a subdirectory of the values repo", () => {
    const files = buildTree(tree({ values: { repoUrl: "https://git/values.git", revision: "main", path: "apps" } }));
    const set = doc(files, "root-applicationSet.yaml");
    expect(set.spec.generators[0].git.directories[0]).toEqual({ path: "apps/*" });
    expect(set.spec.generators[0].git.directories[1]).toEqual({ path: "apps/base", exclude: true });
    // The chart builds the $Values/ refs itself, so the subpath goes in as a
    // parameter — and only when there is one, since the chart already defaults
    // it to the repo root.
    const params = Object.fromEntries(set.spec.template.spec.sources[0].helm.parameters.map((p: any) => [p.name, p.value]));
    expect(params.originPath).toBe("apps");
    expect(doc(files, "root-application.yaml").spec.source.path).toBe("apps");
  });

  it("does not prune from the root app, and cannot mistake a values file for a manifest", () => {
    const root = doc(buildTree(tree()), "root-application.yaml");
    expect(root.spec.syncPolicy.automated.prune).toBe(false);
    // Named outright with recursion off: a glob would also match a release
    // called `web-application` down in <ns>/values/.
    expect(root.spec.source.directory).toEqual({ recurse: false, include: "root-applicationSet.yaml" });
  });
});
