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

/** A root ApplicationSet as a repo wired by hand (or by an older portal) carries it. */
const rootAppset = (originPath: string) => ({
  path: "root-applicationSet.yaml",
  text: `apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata: { name: platform-root-set }
spec:
  generators:
    - git: { repoURL: "https://git.example.com/gitops/values.git", revision: main, directories: [{ path: "*" }] }
  template:
    spec:
      sources:
        - repoURL: https://github.com/devops-ezrahi/universal-chart.git
          targetRevision: main
          path: ms-applicationSet
          helm:
            parameters:
              - { name: chartRepoURL, value: "https://github.com/devops-ezrahi/universal-chart.git" }
              - { name: chartRevision, value: main }
              - { name: chartPath, value: "." }
${originPath ? `              - { name: originPath, value: ${originPath} }
` : ""}`,
});

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

  it("reads <ns>/defaults.yaml back as that namespace's defaults", () => {
    const t = tree({
      namespaces: [
        {
          name: "shop-web",
          defaults: { features: { resources: on({ rcpu: "100m", rmem: "128Mi" }) } },
          releases: [{ release: "r1", features: { image: on({ tag: "1.4.2" }) } }],
        },
      ],
    });
    const { files, again, recovered } = roundTrip(t);
    // The value really is in the file — otherwise this test proves nothing.
    expect(parseYaml(files.find((f) => f.path === "shop-web/defaults.yaml")!.text)).not.toEqual({});
    expect(recovered.namespaces[0].defaults?.features.resources?.on).toBe(true);
    expect(docs(again)).toEqual(docs(files));
  });

  it("keeps a namespace default that a base file also sets, and folds nothing into the overrides", () => {
    // Both bases say replicaCount: 2; shop-prod's defaults say 5 for every
    // microservice there. It stays in defaults.yaml — it is not pushed into
    // each microservice's override file, where nobody set it.
    const t = tree({
      namespaces: [{ name: "shop-prod", defaults: { features: { replicas: on({ replicaCount: 5 }) } }, releases: [] }],
    });
    const { files, again, recovered } = roundTrip(t);
    expect(parseYaml(files.find((f) => f.path === "shop-prod/defaults.yaml")!.text)).toMatchObject({ replicaCount: 5 });
    expect(parseYaml(files.find((f) => f.path === "shop-prod/values/api-gateway.yaml")!.text)).toEqual({});
    expect(recovered.namespaces[0].releases).toHaveLength(0);
    expect(docs(again)).toEqual(docs(files));
  });

  it("names each release after its base file — the file is the release", () => {
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

  it("recovers both repositories and the root app name from a repo's own root-applicationSet.yaml", () => {
    const recovered = importTree([...buildTree(tree()), rootAppset("")]);
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
    const recovered = importTree([...buildTree(tree()), rootAppset("apps")]);
    expect(recovered.values?.path).toBe("apps");
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

describe("a converted ConfigMap survives import and rebuild", () => {
  // The photo: a stalker-configs ConfigMap carrying log4j2.xml and a
  // .properties file came back with the XML split into keys.
  it("writes both files back with every line and indent intact", () => {
    const base = [
      "configMaps:",
      "  stalker-configs:",
      "    data:",
      "      LOG_LEVEL: info",
      "      log4j2.xml: |",
      '        <Configuration status="INFO" monitorInterval="30">',
      "          <Appenders>",
      '            <Socket name="Splunk" host="${env:SPLUNK_HOST}"/>',
      "          </Appenders>",
      "        </Configuration>",
      "      Stalker.properties: |-",
      "        # DB",
      "        dbServer=sgw-dev",
      "        dbPort=5000",
      "",
    ].join("\n");
    const imported = importTree([
      { path: "base/stalker.yaml", text: base },
      { path: "ns1/defaults.yaml", text: "{}\n" },
      { path: "ns1/values/stalker.yaml", text: "{}\n" },
    ]);
    expect(imported.warnings).toEqual([]);
    const files = buildTree(tree({ releases: imported.releases, namespaces: imported.namespaces }));
    const rebuilt = parseYaml(files.find((f) => f.path === "base/stalker.yaml")!.text);
    expect(rebuilt).toEqual(parseYaml(base));
  });
});

describe("variant folders and grouped values", () => {
  // prd/yellow and prd/black both deploy into namespace prd and share base/;
  // values/ groups its files in sub-folders. dev is a plain namespace.
  const repo = [
    { path: "base/ms1.yaml", text: "image:\n  repository: registry/ms1\n  tag: 1.0.0\n" },
    { path: "base/ms2.yaml", text: "image:\n  repository: registry/ms2\n  tag: 1.0.0\n" },
    { path: "prd/yellow/defaults.yaml", text: "color: yellow\n" },
    { path: "prd/yellow/values/group1/ms1.yaml", text: "image:\n  tag: 1.1.0\n" },
    { path: "prd/yellow/values/group2/ms2.yaml", text: "replicaCount: 3\n" },
    { path: "prd/black/defaults.yaml", text: "color: black\n" },
    { path: "prd/black/values/group1/ms1.yaml", text: "image:\n  tag: 1.2.0\n" },
    { path: "prd/black/values/group2/ms2.yaml", text: "{}\n" },
    { path: "dev/defaults.yaml", text: "{}\n" },
    { path: "dev/values/ms1.yaml", text: "{}\n" },
    { path: "dev/values/ms2.yaml", text: "{}\n" },
    { path: "rootApplicationSet.yaml", text: "kind: ApplicationSet\n" },
  ];

  it("reads each variant folder as its own namespace, groups included, and writes it back in place", () => {
    const recovered = importTree(repo);
    // The group value is the chart's to read (via tpl), not a catalog field — kept, and said so.
    expect(recovered.warnings.every((w) => /defaults\.yaml: color: kept as extra values/.test(w))).toBe(true);
    expect(recovered.namespaces.map((n) => n.name)).toEqual(["dev", "prd/black", "prd/yellow"]);

    const yellow = recovered.namespaces.find((n) => n.name === "prd/yellow")!;
    const id = (name: string) => recovered.releases.find((r) => r.name === name)!.id;
    expect(yellow.groups).toEqual({ [id("ms1")]: "group1", [id("ms2")]: "group2" });
    expect(yellow.defaults?.extraValues).toContain("color: yellow");

    const again = buildTree(tree({ releases: recovered.releases, namespaces: recovered.namespaces }));
    const paths = again.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "prd/yellow/defaults.yaml",
        "prd/yellow/values/group1/ms1.yaml",
        "prd/yellow/values/group2/ms2.yaml",
        "prd/black/values/group1/ms1.yaml",
        "dev/values/ms1.yaml",
      ])
    );
    // Nothing lands flat beside a grouped file — that would be a second Application of the same name.
    expect(paths).not.toContain("prd/yellow/values/ms1.yaml");
    const written = docs(again);
    const read = docs(repo.filter((f) => f.path !== "rootApplicationSet.yaml"));
    for (const path of Object.keys(read)) expect(written[path], path).toEqual(read[path]);
  });

  it("says so when one folder has the same release file in two groups", () => {
    const { warnings } = importTree([...repo, { path: "prd/yellow/values/group3/ms1.yaml", text: "{}\n" }]);
    expect(warnings.join()).toMatch(/second ms1\.yaml in prd\/yellow\/values/);
  });
});
