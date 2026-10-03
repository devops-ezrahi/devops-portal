import type { Case } from "./cases";

/**
 * What each chaos case does to the portal today. `chaos.test.ts` runs these;
 * the index the example repo's `chaos` branch carries is written from them too.
 */

export const BUG = {
  docStart: "a values file starting with `---` imports as empty: importValues keeps the text before the marker",
  unparsed: "a file the portal cannot parse is imported as `{}` without a warning, and the rebuild drops what Helm would have read",
  yaml11: "files are read as YAML 1.2, Helm reads YAML 1.1: `yes`/`off` become strings, `0644` becomes 644",
  quoting: "the writer leaves strings bare that Helm reads as numbers or booleans (`y`, `0x1F`, `1_000`, `.inf`)",
  nulls: "a top-level `null` or `[]` is dropped on write, so the base value it removed comes back",
  groupBase: "a release under values/<group>/ gets base/<group>/<file>, but ms-applicationSet reads base/<file>",
  rename: "a release file whose name slug() changes (`ms2.v2`) is written under a new name, deploying a second copy",
  dormant: "a folder with values/ but no defaults.yaml is not deployed, and the rebuild writes one, deploying it",
} as const;

export type Verdict = { kind: "clean" } | { kind: "bug"; why: (typeof BUG)[keyof typeof BUG] } | { kind: "accepted"; why: string };

const clean: Verdict = { kind: "clean" };
const bug = (why: (typeof BUG)[keyof typeof BUG]): Verdict => ({ kind: "bug", why });

export const VERDICTS: Record<string, Verdict> = {
  "doc-start-marker": bug(BUG.docStart),
  "yaml11-booleans": bug(BUG.yaml11),
  "yaml11-octal-mode": bug(BUG.yaml11),
  "yaml11-leading-zero-tag": bug(BUG.yaml11),
  "tricky-strings": bug(BUG.quoting),
  "null-and-empty-scalars": bug(BUG.nulls),
  "null-deletes-whole-section": bug(BUG.nulls),
  "list-cleared": bug(BUG.nulls),
  "invalid-yaml-values": bug(BUG.unparsed),
  "invalid-yaml-defaults": bug(BUG.unparsed),
  "duplicate-keys": bug(BUG.unparsed),
  "multi-document-values": bug(BUG.unparsed),
  "values-not-a-map": bug(BUG.unparsed),
  "group-subfolder-flat-base": bug(BUG.groupBase),
  "group-subfolder-in-one-namespace-only": bug(BUG.groupBase),
  "duplicate-release-in-two-groups": bug(BUG.groupBase),
  "dotted-release": bug(BUG.rename),
  "folder-without-defaults": bug(BUG.dormant),
  "kitchen-sink": bug(BUG.groupBase),
  "orphan-values-file": {
    kind: "accepted",
    why: "a values file with no base never rendered; it is named in a warning and left in the repo",
  },
  "uppercase-underscore-release": {
    kind: "accepted",
    why: "`Payment_API` is not a valid Helm release name, so it never rendered; it comes back as payment-api",
  },
};

export const verdict = (c: Case): Verdict =>
  VERDICTS[c.id] ??
  // A BOM added after the marker hides it: `\uFEFF---` is not the line importValues splits on.
  (c.family === "fuzz" && c.title.includes("doc-start-marker") && !c.title.includes("bom") ? bug(BUG.docStart) : clean);
