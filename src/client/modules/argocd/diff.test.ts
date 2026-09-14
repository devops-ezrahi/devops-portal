import { describe, expect, it } from "vitest";
import { diffLines, diffTree } from "./diff";
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
