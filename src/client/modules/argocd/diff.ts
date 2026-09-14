import type { RepoFile } from "./api";
import type { GeneratedFile } from "./tree";

/**
 * What this tree would do to the values repo, file by file.
 *
 * The builder generates the whole tree every keystroke, so "what changed" is
 * not something it knows — it is the generated files held against the ones the
 * repo has on the connected branch (`pullValues`, the same clone the Pull
 * button makes). Without it a commit is a leap: forty-odd files in the preview,
 * and no way to see that this press moves two of them.
 */

export type FileStatus = "added" | "modified" | "removed" | "unchanged";

/** A generated file plus what the repository has at the same path. */
export type TreeEntry = GeneratedFile & { status?: FileStatus; repoText?: string };

export type DiffLine = { kind: " " | "+" | "-"; text: string };

/** Past this many lines the LCS table stops being free, so the file is reported as replaced whole. */
const MAX_DIFF_LINES = 2000;

/**
 * Generated vs. repository.
 *
 * `deletes` is whether the push actually removes what it does not regenerate —
 * true only when the tree sits in a subdirectory it owns outright. At the
 * repository root the commit only adds and updates (see `pushValuesTree`), and
 * a shared root holds other trees' files, so listing them as removals would
 * name deletions that will not happen.
 */
export function diffTree(files: GeneratedFile[], repo: RepoFile[], deletes: boolean): TreeEntry[] {
  const inRepo = new Map(repo.map((f) => [f.path, f.text]));
  const entries: TreeEntry[] = files.map((file) => {
    const repoText = inRepo.get(file.path);
    return {
      ...file,
      repoText,
      status: repoText === undefined ? "added" : repoText === file.text ? "unchanged" : "modified",
    };
  });
  if (deletes) {
    const generated = new Set(files.map((f) => f.path));
    for (const file of repo) {
      if (generated.has(file.path)) continue;
      entries.push({
        path: file.path,
        text: "",
        repoText: file.text,
        status: "removed",
        note: "in the repository, not in this tree",
      });
    }
  }
  return entries;
}

/**
 * A line diff, by longest common subsequence.
 *
 * ponytail: O(n·m) table, which is free on files this size (a values file is
 * tens of lines) and bailed out of past `MAX_DIFF_LINES`. Swap in a proper
 * Myers diff if these ever stop being small.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  if (n + m > MAX_DIFF_LINES)
    return [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "-", text: a[i++] });
    } else {
      out.push({ kind: "+", text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "-", text: a[i++] });
  while (j < m) out.push({ kind: "+", text: b[j++] });
  return out;
}
