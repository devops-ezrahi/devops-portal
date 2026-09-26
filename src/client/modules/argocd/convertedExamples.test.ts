import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { describe, expect, it } from "vitest";
import { importTree } from "./importTree";
import { buildTree } from "./tree";
import { parseValues } from "./build";
import type { ArgocdTree } from "../../../server/types";

/**
 * The two example trees `convert_to_universal_chart.py` writes in the
 * universal-chart repo (`examples/converted/{flat,grouped}/output`), copied
 * here verbatim: one plain namespace-per-folder tree, one with
 * `--env-group color=black,yellow` variant folders (`dev/yellow`, `prd/black`)
 * and `{{ .Values.color }}` / `{{ .Values.environment }}` in base.
 */
const DIR = join(__dirname, "__tests__", "converted");

function read(dir: string) {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk(dir).map((f) => ({ path: relative(dir, f).split(sep).join("/"), text: readFileSync(f, "utf8") }));
}

const values = (files: { path: string; text: string }[]) =>
  Object.fromEntries(
    files.filter((f) => f.path.endsWith(".yaml") && !f.path.startsWith("root")).map((f) => [f.path, parseValues(f.text) ?? {}])
  );

describe.each(["flat", "grouped"])("converter example: %s", (name) => {
  const files = read(join(DIR, name));
  const imported = importTree(files);

  it("imports with no warnings and recovers the wiring", () => {
    // `environment` / `color` in defaults.yaml are read by base's `{{ .Values.<key> }}`: kept, not warned about.
    expect(imported.warnings).toEqual([]);
    expect(imported.releases.map((r) => r.name)).toEqual(["ms1", "ms2"]);
    expect(imported.values?.repoUrl).toBe(`https://github.com/devops-ezrahi/universal-chart-example-${name}.git`);
    expect(imported.chart?.appsetPath).toBe("ms-applicationSet");
  });

  it("rebuilds every base/, defaults.yaml and values/ file to the same document", () => {
    const tree = { releases: imported.releases, namespaces: imported.namespaces } as unknown as ArgocdTree;
    expect(values(buildTree(tree))).toEqual(values(files));
  });
});

describe("the grouped example", () => {
  const imported = importTree(read(join(DIR, "grouped")));

  it("reads every variant folder as its own namespace", () => {
    expect(imported.namespaces.map((n) => n.name)).toEqual(["dev", "dev/black", "dev/yellow", "prd", "prd/black", "prd/yellow"]);
  });

  it("runs ms1 only in the colour folders and ms2 only in the namespace folder", () => {
    const id = (name: string) => imported.releases.find((r) => r.name === name)!.id;
    const absent = Object.fromEntries(imported.namespaces.map((n) => [n.name, n.absent ?? []]));
    expect(absent["dev"]).toEqual([id("ms1")]);
    expect(absent["dev/yellow"]).toEqual([id("ms2")]);
  });
});
