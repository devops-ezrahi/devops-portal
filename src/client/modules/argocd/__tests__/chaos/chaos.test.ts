import { join } from "path";
import { describe, expect, it } from "vitest";
import { deploy, drift, helmParse } from "./argo";
import type { BaseLayout } from "./argo";
import { CASES, fuzzCase } from "./cases";
import { readTree, runCase } from "./run";
import { BUG, verdict } from "./verdicts";

/**
 * Chaos against the ArgoCD builder: hand-edited variants of the grouped
 * example tree, pulled, imported, rebuilt and pushed the way the portal does
 * it, and judged by what Argo CD would deploy before and after (`argo.ts`).
 *
 * A case is `clean` when the push changes nothing Argo deploys — at the repo
 * root (overlay) and under `values.path` (replace) — and a later edit to a
 * release's base reaches every Application running it. `bug` cases do not hold
 * that today; they run as `it.fails`, so fixing one turns its test red until
 * it moves to `clean`. `accepted` drift is intended, and its test pins how.
 *
 * Seeds: `example-grouped` is the universal-chart-example-grouped repo's
 * `main` as GitHub has it, `converted/grouped` the richer copy the converter
 * tests use (configMaps, cronjobs, block scalars). Each runs under both chart
 * layouts — `main` reads base/<file>, `dev` base/<group>/<file> (`argo.ts`).
 */

const SEEDS = {
  "example-grouped": join(__dirname, "seeds", "example-grouped"),
  "converted/grouped": join(__dirname, "..", "converted", "grouped"),
};
const LAYOUTS: [string, BaseLayout][] = [
  ["chart main (flat base/)", "flat"],
  ["chart dev (base/ mirrors values/)", "mirrored"],
];

const FUZZ = Array.from({ length: 30 }, (_, i) => fuzzCase(i + 1));

/** Everything that makes a case not clean, as readable lines — so a failure says what moved. */
function problems(o: ReturnType<typeof runCase>): string[] {
  return [
    ...(o.crash ? [`crash: ${o.crash}`] : []),
    ...(o.overlay?.drift ?? []).map((d) => `push at repo root: ${d.app} ${d.kind}: ${d.detail}`),
    ...(o.replace?.drift ?? []).map((d) => `push under values.path: ${d.app} ${d.kind}: ${d.detail}`),
    ...o.unseenEdits.map((a) => `a base edit does not reach ${a}`),
  ];
}

describe.each(Object.entries(SEEDS).flatMap(([name, dir]) => LAYOUTS.map(([label, layout]) => [`${name}, ${label}`, dir, layout] as const)))("chaos on %s", (_name, dir, layout) => {
  const seed = readTree(dir);

  describe.each([...CASES, ...FUZZ].map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const v = verdict(c, layout);
    if (v.kind === "accepted") {
      it(`is accepted: ${v.why}`, () => {
        const o = runCase(seed, c, layout);
        expect(o.crash).toBeUndefined();
        // Nothing that rendered may change: only Applications that never rendered
        // move, and the one that replaces them is new.
        for (const d of [...o.overlay!.drift, ...o.replace!.drift])
          if (d.kind !== "added") expect(o.before.apps.get(d.app)?.error, `${d.app} ${d.kind}`).toBeDefined();
        expect(o.unseenEdits).toEqual([]);
      });
      return;
    }
    const test = v.kind === "bug" ? it.fails : it;
    test(v.kind === "bug" ? `known bug: ${v.why}` : "deploys the same thing after a pull, import, rebuild and push", () => {
      expect(problems(runCase(seed, c, layout))).toEqual([]);
    });
  });

  it("the fuzz cases only re-spell the tree: each deploys exactly what the seed does", () => {
    const want = deploy(seed, layout);
    for (const c of FUZZ) expect(drift(want, deploy(c.mutate(seed), layout)), c.title).toEqual([]);
  });
});

describe("the oracle reads values the way Helm does", () => {
  // Each row was checked against `helm template` (v3.16) dumping `.Values` as JSON.
  it.each([
    ["a: yes", true],
    ["a: on", true],
    ["a: off", false],
    ["a: y", true],
    ["a: N", false],
    ["a: 0644", 420],
    ["a: 0123", 83],
    ["a: 0x1F", 31],
    ["a: 0o17", 15],
    ["a: 1_000", 1000],
    ["a: +12", 12],
    ["a: 1.10", 1.1],
    ["a: 12:30", "12:30"],
    ["a: 2001-12-14", "2001-12-14"],
    ['a: "yes"', "yes"],
    ["a: '0x1F'", "0x1F"],
    ["a: ~", null],
  ])("%s", (text, want) => {
    expect(helmParse(text).doc).toEqual({ a: want });
  });

  it("keeps the last of two equal keys, reads only the first document, and fails on .inf and on a list", () => {
    expect(helmParse("k: 1\nk: 2\n").doc).toEqual({ k: 2 });
    expect(helmParse("---\na: 1\n---\nb: 2\n").doc).toEqual({ a: 1 });
    expect(helmParse("a: .inf\n").error).toBeTruthy();
    expect(helmParse("- a\n").error).toBeTruthy();
    expect(helmParse("").doc).toEqual({});
  });
});

/**
 * The chaos branch's round-2 namespaces as the converter wrote them
 * (universal-chart `dev`, so base/ mirrors values/): `edge` and `team-dev` from
 * `generate_chaos.py`'s `edge_main()`, plus `dev`'s redis-cache that
 * `team-dev`'s collides with. Nothing hand-edited — so any drift is the portal's.
 */
describe("chaos on the converter's own output (example repo, branch chaos, round 2)", () => {
  const seed = readTree(join(__dirname, "seeds", "example-chaos-edge"));
  const layout: BaseLayout = "mirrored";
  // What a plain pull + push already changes: the converter quoted "0x1F",
  // "1_000", ".inf"..., the writer does not (BUG.quoting); and
  // metrics.exporter.yaml comes back as metrics-exporter.yaml (BUG.rename).
  const KNOWN = /^push (at repo root|under values\.path): (yaml-traps-edge values|metrics[.-]exporter-edge (added|lost))|^a base edit does not reach metrics\.exporter-edge/;
  const identity = CASES.find((c) => c.id === "identity")!;

  it.fails(`known bugs: ${BUG.quoting}; ${BUG.rename}`, () => {
    expect(problems(runCase(seed, identity, layout))).toEqual([]);
  });

  it("drifts in exactly those two Applications, and nowhere else", () => {
    const found = problems(runCase(seed, identity, layout));
    expect(found.filter((p) => !KNOWN.test(p))).toEqual([]);
    expect(found.some((p) => p.includes("yaml-traps-edge"))).toBe(true);
    expect(found.some((p) => p.includes("metrics-exporter-edge"))).toBe(true);
  });

  it.each(CASES.filter((c) => c.family === "format" && !["identity", "anchors-and-aliases", "block-scalars", "doc-start-marker"].includes(c.id)).map((c) => [c.id, c] as const))(
    "re-spelled as %s, adds no drift of its own",
    (_id, c) => {
      expect(problems(runCase(seed, c, layout)).filter((p) => !KNOWN.test(p))).toEqual([]);
    }
  );

  it("knows team-dev's redis-cache collides with dev's, before the portal touches anything", () => {
    expect(deploy(seed, layout).collisions).toEqual(["redis-cache-dev"]);
  });
});
