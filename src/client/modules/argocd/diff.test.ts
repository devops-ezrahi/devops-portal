import { describe, expect, it } from "vitest";
import { diffLines, diffTree, diffValues } from "./diff";
import type { GeneratedFile } from "./tree";

const gen = (path: string, text: string): GeneratedFile => ({ path, text, note: "" });

describe("diffTree", () => {
  const files = [gen("base/a.yaml", "one\n"), gen("base/b.yaml", "two\n")];

  it("marks a file the repo does not have, one it has differently, and one it matches", () => {
    const entries = diffTree(files, [{ path: "base/a.yaml", text: "changed\n" }], false);
    expect(entries.map((e) => [e.path, e.status])).toEqual([
      ["base/a.yaml", "modified"],
      ["base/b.yaml", "added"],
    ]);
    expect(entries[0].repoText).toBe("changed\n");
  });

  it("says nothing was modified when the tree matches the repository", () => {
    const repo = files.map((f) => ({ path: f.path, text: f.text }));
    expect(diffTree(files, repo, true).every((e) => e.status === "unchanged")).toBe(true);
  });

  it("does not call a file changed when only its key order and comments differ", () => {
    const tree = [gen("base/a.yaml", "# written by the builder\nimage:\n  tag: 1.0\nreplicaCount: 2\n")];
    const repo = [{ path: "base/a.yaml", text: "# written by hand\nreplicaCount: 2\nimage:\n  tag: 1.0\n" }];
    const [entry] = diffTree(tree, repo, false);
    expect(entry.status).toBe("unchanged");
    expect(entry.note).toMatch(/different order/);
  });

  it("still reports a file whose values really moved", () => {
    const tree = [gen("base/a.yaml", "replicaCount: 3\n")];
    const repo = [{ path: "base/a.yaml", text: "replicaCount: 2\n" }];
    expect(diffTree(tree, repo, false)[0].status).toBe("modified");
  });

  it("only reports a removal when the push would actually delete it", () => {
    const repo = [{ path: "base/gone.yaml", text: "old\n" }];
    expect(diffTree(files, repo, false).some((e) => e.status === "removed")).toBe(false);
    const removed = diffTree(files, repo, true).find((e) => e.status === "removed");
    expect(removed?.path).toBe("base/gone.yaml");
    expect(removed?.repoText).toBe("old\n");
  });
});

describe("diffLines", () => {
  it("keeps the common lines as context and marks only what moved", () => {
    const lines = diffLines("a\nb\nc\n", "a\nB\nc\n");
    expect(lines.map((l) => l.kind + l.text)).toEqual([" a", "-b", "+B", " c", " "]);
  });

  it("handles a pure insertion without rewriting the file", () => {
    const lines = diffLines("a\nc", "a\nb\nc");
    expect(lines.filter((l) => l.kind !== " ").map((l) => l.kind + l.text)).toEqual(["+b"]);
  });

  it("falls back to a whole-file replace past the line ceiling", () => {
    const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`).join("\n");
    expect(diffLines(big, big).some((l) => l.kind === " ")).toBe(false);
  });
});

describe("diffValues", () => {
  // The complaint this answers: a block that only moved was eight removals and
  // eight additions of the same lines, and the one value that did change was
  // lost in them.
  const before = [
    "volumeClaimTemplates:",
    "  data:",
    "    size: 50Gi",
    "volumes:",
    "  initscripts:",
    "    configMap:",
    "      name: db-init",
    "",
  ].join("\n");
  const after = [
    "volumes:",
    "  initscripts:",
    "    configMap:",
    "      name: db-init",
    "volumeClaimTemplates:",
    "  data:",
    "    size: 50Gi",
    "",
  ].join("\n");

  it("reports nothing when a block only moved", () => {
    expect(diffValues(before, after).every((l) => l.kind === " ")).toBe(true);
  });

  it("reports the one value that did change, and only that", () => {
    const changed = after.replace("50Gi", "100Gi");
    const marked = diffValues(before, changed).filter((l) => l.kind !== " ");
    expect(marked.map((l) => l.kind + l.text.trim())).toEqual(["-size: 50Gi", "+size: 100Gi"]);
  });

  it("falls back to the raw text when a side will not parse", () => {
    const broken = "volumes: [unclosed\n";
    expect(diffValues(broken, after).some((l) => l.kind !== " ")).toBe(true);
  });
});
