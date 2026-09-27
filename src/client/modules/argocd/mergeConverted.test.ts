import { describe, expect, it } from "vitest";
import { buildValues } from "./build";
import { mergeConverted, newTree } from "./document";
import { importTree } from "./importTree";
import { buildTree } from "./tree";
import { parse } from "yaml";

// What convert_to_universal_chart.py writes for one microservice in one namespace.
const converted = (ns: string, name: string, repo: string, defaults = "{}\n") =>
  importTree([
    { path: `base/${name}.yaml`, text: `image:\n  repository: ${repo}\n` },
    { path: `${ns}/defaults.yaml`, text: defaults },
    { path: `${ns}/values/${name}.yaml`, text: "image:\n  tag: 1.1.1\n" },
  ]);

const on = (v: Record<string, unknown>) => ({ on: true, v });

describe("mergeConverted", () => {
  it("fills an empty tree, ready to connect and commit", () => {
    const { tree } = mergeConverted(newTree(), converted("interconn", "stalker", "reg/stalker"));
    const paths = buildTree({ ...tree, name: "t" }).map((f) => f.path);
    expect(paths).toContain("base/stalker.yaml");
    expect(paths).toContain("interconn/values/stalker.yaml");
  });

  it("adds to a connected tree without touching what it holds", () => {
    const start = {
      ...newTree(),
      values: { repoUrl: "https://bb/scm/p/values.git", revision: "main", path: "" },
      releases: [{ id: "r-old", name: "gateway", features: { image: on({ repository: "reg/gw" }) } }],
      namespaces: [{ name: "interconn", releases: [], defaults: { features: { image: on({ tag: "9.9.9" }) } } }],
    };
    const { tree, replaced } = mergeConverted(start, converted("interconn", "stalker", "reg/stalker"));
    expect(replaced).toEqual([]);
    expect(tree.values.repoUrl).toBe("https://bb/scm/p/values.git");
    expect(tree.releases.map((r) => r.name)).toEqual(["gateway", "stalker"]);
    // The namespace keeps its own defaults, and gains one entry.
    expect(buildValues(tree.namespaces[0].defaults!.features)).toEqual({ image: { tag: "9.9.9" } });
    const entry = tree.namespaces[0].releases.find((e) => e.release === tree.releases[1].id)!;
    expect(buildValues(entry.features, entry.extraValues)).toEqual({ image: { tag: "1.1.1" } });
  });

  it("replaces a same-named microservice in place, keeping its id", () => {
    const start = { ...newTree(), releases: [{ id: "r-keep", name: "stalker", features: { image: on({ repository: "old" }) } }] };
    const { tree, replaced } = mergeConverted(start, converted("ns", "stalker", "new"));
    expect(replaced).toEqual(["stalker"]);
    expect(tree.releases).toHaveLength(1);
    expect(tree.releases[0].id).toBe("r-keep");
    expect(buildValues(tree.releases[0].features)).toEqual({ image: { repository: "new" } });
  });

  it("folds the converter's namespace defaults into the entry when the namespace already exists", () => {
    const start = { ...newTree(), namespaces: [{ name: "ns", releases: [], defaults: { features: {} } }] };
    const { tree } = mergeConverted(start, converted("ns", "stalker", "reg", "replicaCount: 3\n"));
    const file = buildTree({ ...tree, name: "t" }).find((f) => f.path === "ns/values/stalker.yaml")!;
    expect(parse(file.text)).toEqual({ replicaCount: 3, image: { tag: "1.1.1" } });
  });
});
