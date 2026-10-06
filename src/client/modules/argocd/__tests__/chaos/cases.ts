import { helmParse } from "./argo";
import type { RepoFile } from "../../importTree";

/**
 * Chaos for a values repo: what a converted tree turns into once people have
 * hand-edited it for a year. Each case takes a clean tree (the grouped example:
 * base/ms1+ms2, dev|prd, black|yellow variant folders) and returns a mutated
 * copy. Nothing here decides pass or fail — `chaos.test.ts` asks the Argo
 * oracle whether the portal's import + rebuild still deploys the same thing.
 */

export type Files = RepoFile[];
export type Case = { id: string; family: string; title: string; mutate: (files: Files) => Files };

// ---- file helpers -----------------------------------------------------------

const get = (f: Files, path: string) => f.find((x) => x.path === path)?.text;
const put = (f: Files, path: string, text: string): Files => [...f.filter((x) => x.path !== path), { path, text }];
const drop = (f: Files, path: string): Files => f.filter((x) => x.path !== path);
const edit = (f: Files, path: string, fn: (t: string) => string): Files => {
  const t = get(f, path);
  if (t === undefined) throw new Error(`chaos: ${path} is not in the seed`);
  return put(f, path, fn(t));
};
const editAll = (f: Files, test: (p: string) => boolean, fn: (t: string, p: string) => string): Files =>
  f.map((x) => (test(x.path) ? { ...x, text: fn(x.text, x.path) } : x));
/**
 * A re-spelling, applied file by file only where Helm still reads the same
 * values — a regex cannot tell a multi-line plain scalar from a new key, and a
 * format case that changed what a file means would blame the portal for it.
 */
const respell = (f: Files, fn: (t: string, p: string) => string): Files =>
  editAll(f, isYaml, (t, p) => {
    const out = fn(t, p);
    return JSON.stringify(helmParse(out)) === JSON.stringify(helmParse(t)) ? out : t;
  });
const move = (f: Files, from: string, to: string): Files => put(drop(f, from), to, get(f, from)!);
const append = (f: Files, path: string, text: string) => edit(f, path, (t) => `${t.replace(/\n*$/, "\n")}${text}`);
const isYaml = (p: string) => p.endsWith(".yaml") && !p.startsWith("root");
/** Add entries under a file's `env:` — its existing one, or a new one: a second `env:` key would be a different case. */
const underEnv = (f: Files, path: string, lines: string) =>
  edit(f, path, (t) => (/^env:\n/m.test(t) ? t.replace(/^env:\n/m, `env:\n${lines}`) : `${t.replace(/\n*$/, "\n")}\nenv:\n${lines}`));
const valuesFiles = (f: Files) => f.filter((x) => /\/values\/.+\.yaml$/.test(x.path)).map((x) => x.path);

/** A copy of `folder` (defaults + values) under another name, with `color:`/`environment:` lines rewritten. */
function cloneFolder(f: Files, from: string, to: string, rewrite: (t: string) => string = (t) => t): Files {
  const extra = f
    .filter((x) => x.path.startsWith(`${from}/defaults.yaml`) || x.path.startsWith(`${from}/values/`))
    .map((x) => ({ path: to + x.path.slice(from.length), text: rewrite(x.text) }));
  return [...f, ...extra];
}

/**
 * Rewrite every line that is not inside a `|` / `>` block scalar — whose
 * content, trailing spaces included, is the value itself.
 */
function outsideBlocks(t: string, fn: (line: string) => string): string {
  let blockIndent = -1;
  return t
    .split("\n")
    .map((l) => {
      const ind = l.search(/\S/);
      if (blockIndent >= 0 && (ind === -1 || ind > blockIndent)) return l;
      blockIndent = /:\s*[|>][-+0-9]*\s*$/.test(l) ? ind : -1;
      return l.trim() ? fn(l) : l;
    })
    .join("\n");
}
const endsInBlock = (t: string) => outsideBlocks(t.replace(/\n*$/, ""), () => "") .split("\n").pop() !== "";

// Re-indent a block YAML document from 2 to `n` spaces per level.
const reindent = (t: string, n: number) =>
  t.replace(/^( +)/gm, (m) => " ".repeat((m.length / 2) * n));

const FIRST_CASES: Case[] = [
  // ======================= formatting: same values, different bytes ==========
  { id: "identity", family: "format", title: "nothing changed: the tree exactly as committed", mutate: (f) => f },
  {
    id: "comments-everywhere",
    family: "format",
    title: "full-line and trailing comments on every key, including `{{ .Values.x }}` inside a comment",
    mutate: (f) =>
      respell(f, (t) =>
        t
          .split("\n")
          .map((l) => (/^\s*[\w-]+:\s*\S/.test(l) && !/[|>]-?\s*$/.test(l) && !l.includes("#") ? `${l}   # was {{ .Values.oldKey }}` : l))
          .join("\n")
          .replace(/^(\w)/gm, "# section ->\n$1")
      ),
  },
  { id: "crlf", family: "format", title: "Windows line endings in every file", mutate: (f) => respell(f, (t) => t.replace(/\n/g, "\r\n")) },
  { id: "bom", family: "format", title: "UTF-8 byte-order mark at the top of every file", mutate: (f) => respell(f, (t) => `\uFEFF${t}`) },
  { id: "doc-start-marker", family: "format", title: "`---` document start marker on every file", mutate: (f) => respell(f, (t) => `---\n${t}`) },
  { id: "doc-end-marker", family: "format", title: "`...` document end marker on every file", mutate: (f) => respell(f, (t) => `${t.replace(/\n*$/, "\n")}...\n`) },
  { id: "indent-4", family: "format", title: "four-space indentation", mutate: (f) => respell(f, (t) => reindent(t, 4)) },
  {
    id: "no-trailing-newline-and-trailing-spaces",
    family: "format",
    title: "trailing spaces on lines, no newline at end of file",
    mutate: (f) => respell(f, (t) => outsideBlocks(t, (l) => `${l}  `).replace(/[ \t]*\n*$/, (m) => (endsInBlock(t) ? m : ""))),
  },
  {
    id: "flow-style",
    family: "format",
    title: "image and replicaCount written as one flow mapping per values file",
    mutate: (f) =>
      respell(f, (t, p) =>
        /\/values\//.test(p) ? t.replace(/^image:\n  repository: (.+)\n  tag: (.+)\n/m, "image: {repository: $1, tag: \"$2\"}\n") : t
      ),
  },
  {
    id: "quoted-everything",
    family: "format",
    title: "every key and scalar double-quoted",
    mutate: (f) =>
      respell(f, (t) =>
        t.replace(/^(\s*)([\w-]+): ([^'"{}\n#|>&*!%@`][^\n#]*?)\s*$/gm, (_m, ind, k, v) => `${ind}"${k}": ${JSON.stringify(v)}`)
      ),
  },
  {
    id: "key-order-reversed",
    family: "format",
    title: "top-level sections in reverse order",
    mutate: (f) =>
      respell(f, (t) => {
        const blocks = t.split(/\n(?=\w)/);
        const head = blocks[0].startsWith("#") ? [blocks.shift()!] : [];
        return [...head, ...blocks.reverse()].join("\n") + "\n";
      }),
  },
  {
    id: "anchors-and-aliases",
    family: "format",
    title: "an anchor in a values file, reused by alias and through a `<<:` merge key",
    mutate: (f) =>
      edit(f, "dev/values/ms2.yaml", (t) =>
        t.replace(/^image:\n  repository: (.+)\n  tag: (.+)\n/m, "image: &img\n  repository: $1\n  tag: $2\n") +
        "\nsidecars:\n  shadow:\n    image: *img\n    command: [sleep, infinity]\n" +
        "\nresources: &res\n  limits:\n    cpu: 500m\n" +
        "\npodAnnotations:\n  <<: {team: core}\n  owner: platform\n"
      ),
  },
  {
    id: "block-scalars",
    family: "format",
    title: "env values as folded / literal block scalars",
    mutate: (f) =>
      append(f, "dev/values/ms2.yaml", "\nextraEnvNote: >-\n  folded\n  into one line\nscript: |\n  #!/bin/sh\n  echo hi\n"),
  },

  // ======================= types: YAML 1.1 (Helm) vs YAML 1.2 =================
  {
    id: "yaml11-booleans",
    family: "types",
    title: "`yes` / `on` / `off` / `y` booleans (true/false to Helm)",
    mutate: (f) =>
      append(f, "dev/values/ms2.yaml", "\nautoscaling:\n  enabled: yes\npodDisruptionBudget:\n  enabled: on\n  minAvailable: 1\nhostNetwork: off\nmyFlags:\n  shortYes: y\n  shortNo: N\n"),
  },
  {
    id: "yaml11-octal-mode",
    family: "types",
    title: "a volume `defaultMode: 0644` (octal 420 to Helm)",
    mutate: (f) =>
      append(f, "dev/values/ms2.yaml", "\nvolumes:\n  creds:\n    secret:\n      secretName: db\n      defaultMode: 0644\nvolumeMounts:\n  creds:\n    mountPath: /creds\n"),
  },
  {
    id: "yaml11-leading-zero-tag",
    family: "types",
    title: "image tag `0123` unquoted (octal 83 to Helm)",
    mutate: (f) => edit(f, "dev/values/ms2.yaml", (t) => t.replace(/tag: .+/, "tag: 0123")),
  },
  {
    id: "yaml11-sexagesimal",
    family: "types",
    title: "image tag `12:30` unquoted (sexagesimal 750 to Helm)",
    mutate: (f) => edit(f, "dev/values/ms2.yaml", (t) => t.replace(/tag: .+/, "tag: 12:30")),
  },
  {
    id: "float-tags",
    family: "types",
    title: "image tags `1.10` and `2.0` unquoted (floats 1.1 and 2)",
    mutate: (f) =>
      edit(edit(f, "dev/values/ms2.yaml", (t) => t.replace(/tag: .+/, "tag: 1.10")), "prd/values/ms2.yaml", (t) => t.replace(/tag: .+/, "tag: 2.0")),
  },
  {
    id: "tricky-strings",
    family: "types",
    title: "quoted strings that look like other types: \"y\", \"0x1F\", \"1_000\", \".inf\", \"1e3\", \"2001-12-14\", \"null\", \"~\"",
    mutate: (f) =>
      append(
        f,
        "dev/values/ms2.yaml",
        [
          "",
          "podLabels:",
          '  short-yes: "y"',
          '  short-no: "n"',
          '  hex: "0x1F"',
          '  octal-o: "0o17"',
          '  underscored: "1_000"',
          '  infinity: ".inf"',
          '  not-a-number: ".NaN"',
          '  sci: "1e3"',
          '  date: "2001-12-14"',
          '  null-word: "null"',
          '  tilde: "~"',
          '  colon-space: "a: b"',
          '  hash: "a #b"',
          '  leading-star: "*star"',
          '  leading-dash: "- dash"',
          '  merge-key: "<<"',
          '  equals: "="',
          '  sexagesimal: "1:30"',
          '  plus-int: "+12"',
          '  empty: ""',
          "",
        ].join("\n")
      ),
  },
  {
    id: "null-and-empty-scalars",
    family: "types",
    title: "keys set to `~`, `null` and nothing at all",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\nnodeSelector: ~\ntolerations: null\naffinity:\n"),
  },
  {
    id: "unicode",
    family: "types",
    title: "Hebrew, emoji and right-to-left text in values and comments",
    mutate: (f) =>
      append(f, "dev/values/ms2.yaml", "\n# הערה בעברית 🚀\npodAnnotations:\n  description: שירות תשלומים 💳\n  owner: \"צוות-ליבה\"\n"),
  },
  {
    id: "long-and-special-strings",
    family: "types",
    title: "a 5 KB string, a JSON blob, a string with a trailing newline and leading spaces",
    mutate: (f) =>
      append(
        f,
        "dev/values/ms2.yaml",
        `\npodAnnotations:\n  big: "${"x".repeat(5000)}"\n  json: '{"a": [1, 2, {"b": null}]}'\n  trailing-nl: "line\\n"\n  leading-space: "  indented"\n  tab: "a\\tb"\n`
      ),
  },

  // ======================= values semantics ===================================
  {
    id: "null-deletes-base-key",
    family: "semantics",
    title: "`env: {COLOR: null}` — a folder removes an env var base sets (Helm's delete-by-null)",
    mutate: (f) => underEnv(f, "dev/black/values/ms1.yaml", "  COLOR: null\n"),
  },
  {
    id: "null-deletes-whole-section",
    family: "semantics",
    title: "`service: null` — a folder switches off a section base defines",
    mutate: (f) => append(f, "prd/values/ms2.yaml", "\nservice: null\n"),
  },
  {
    id: "empty-file",
    family: "semantics",
    title: "a zero-byte values file (release runs with no overrides)",
    mutate: (f) => put(f, "prd/values/ms2.yaml", ""),
  },
  {
    id: "comment-only-file",
    family: "semantics",
    title: "a values file holding only comments",
    mutate: (f) => put(f, "prd/values/ms2.yaml", "# nothing to override here\n# keep this file: it is what deploys ms2\n"),
  },
  { id: "explicit-empty-map", family: "semantics", title: "a values file that is just `{}`", mutate: (f) => put(f, "prd/values/ms2.yaml", "{}\n") },
  {
    id: "empty-defaults",
    family: "semantics",
    title: "a zero-byte defaults.yaml",
    mutate: (f) => put(f, "prd/defaults.yaml", ""),
  },
  {
    id: "invalid-yaml-values",
    family: "semantics",
    title: "a values file with a YAML syntax error (bad indentation)",
    mutate: (f) => edit(f, "dev/values/ms2.yaml", (t) => t.replace("image:\n  repository", "image:\n    repository").replace("  tag:", " tag:")),
  },
  {
    id: "invalid-yaml-defaults",
    family: "semantics",
    title: "a defaults.yaml with an unterminated quote",
    mutate: (f) => append(f, "dev/black/defaults.yaml", 'owner: "platform\n'),
  },
  {
    id: "duplicate-keys",
    family: "semantics",
    title: "the same key twice in one values file",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\nreplicaCount: 3\n"),
  },
  {
    id: "multi-document-values",
    family: "semantics",
    title: "a second YAML document appended to a values file (Helm reads the first)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "---\nreplicaCount: 9\n"),
  },
  {
    id: "values-not-a-map",
    family: "semantics",
    title: "a values file that is a YAML list",
    mutate: (f) => put(f, "prd/values/ms2.yaml", "- image: registry.example.org/ms2:1.0.0\n"),
  },
  {
    id: "unknown-top-level-keys",
    family: "semantics",
    title: "keys the chart does not read (company metadata, a `global:` block)",
    mutate: (f) =>
      append(append(f, "base/ms2.yaml", "\nglobal:\n  costCenter: 42\nmyCompany:\n  owner: team-a\n"), "dev/values/ms2.yaml", "\nmyCompany:\n  pager: '#ops'\n"),
  },
  {
    id: "deep-override",
    family: "semantics",
    title: "a folder overrides one nested key of a base map (`service.ports.http.port`)",
    mutate: (f) => append(f, "prd/values/ms2.yaml", "\nservice:\n  ports:\n    http:\n      port: 9090\n"),
  },
  {
    id: "list-replace",
    family: "semantics",
    title: "base sets a list, a folder replaces it with a shorter one",
    mutate: (f) =>
      append(append(f, "base/ms2.yaml", "\nargs:\n- --a\n- --b\n- --c\n"), "dev/values/ms2.yaml", "\nargs:\n- --only\n"),
  },
  {
    id: "list-cleared",
    family: "semantics",
    title: "base sets a list, a folder clears it with `[]`",
    mutate: (f) => append(append(f, "base/ms2.yaml", "\nargs:\n- --a\n"), "dev/values/ms2.yaml", "\nargs: []\n"),
  },
  {
    id: "map-cleared",
    family: "semantics",
    title: "base sets podAnnotations, a folder writes `podAnnotations: {}` (a no-op to Helm)",
    mutate: (f) => append(append(f, "base/ms2.yaml", "\npodAnnotations:\n  a: b\n"), "dev/values/ms2.yaml", "\npodAnnotations: {}\n"),
  },
  {
    id: "restates-base",
    family: "semantics",
    title: "a values file restating base exactly (service type, container name)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\ncontainerName: app\nservice:\n  type: ClusterIP\n  enabled: true\n"),
  },
  {
    id: "defaults-override-base",
    family: "semantics",
    title: "a defaults.yaml that overrides release keys for the whole folder",
    mutate: (f) => append(f, "prd/defaults.yaml", "\nreplicaCount: 3\nresources:\n  limits:\n    memory: 512Mi\n"),
  },
  {
    id: "values-undo-defaults",
    family: "semantics",
    title: "defaults sets replicaCount 3, a values file sets it back to 1 (the chart default)",
    mutate: (f) => {
      const g = append(f, "prd/defaults.yaml", "\nreplicaCount: 3\n");
      return edit(g, "prd/values/ms2.yaml", (t) => (/replicaCount/.test(t) ? t.replace(/replicaCount: \d+/, "replicaCount: 1") : `${t}\nreplicaCount: 1\n`));
    },
  },
  {
    id: "templated-values-file",
    family: "semantics",
    title: "a values file using a new group value `{{ .Values.region }}` that only defaults.yaml sets",
    mutate: (f) =>
      append(append(f, "prd/black/defaults.yaml", "\nregion: eu\n"), "prd/black/values/ms1.yaml", "\npodLabels:\n  region: '{{ .Values.region }}'\n"),
  },
  {
    id: "defaults-only-release-keys",
    family: "semantics",
    title: "a variant folder whose defaults.yaml carries image + env for every release in it",
    mutate: (f) => append(f, "dev/yellow/defaults.yaml", "\nimage:\n  repository: registry.example.org/yellow-mirror\nenv:\n  MIRROR:\n    value: 'true'\n"),
  },

  // ======================= layout =============================================
  {
    id: "group-subfolder-flat-base",
    family: "layout",
    title: "values/team-a/ms2.yaml grouping sub-folder, base/ms2.yaml flat (what the chart reads)",
    mutate: (f) => move(move(f, "dev/values/ms2.yaml", "dev/values/team-a/ms2.yaml"), "prd/values/ms2.yaml", "prd/values/team-a/ms2.yaml"),
  },
  {
    id: "group-subfolder-in-one-namespace-only",
    family: "layout",
    title: "ms2 grouped under values/team-a in dev but flat in prd",
    mutate: (f) => move(f, "dev/values/ms2.yaml", "dev/values/team-a/ms2.yaml"),
  },
  {
    id: "deeper-variant",
    family: "layout",
    title: "a third level: prd/black/eu with its own defaults.yaml",
    mutate: (f) => cloneFolder(append(f, "prd/black/defaults.yaml", ""), "prd/black", "prd/black/eu", (t) => (t.includes("color:") ? `${t}\nregion: eu\n` : t)),
  },
  {
    id: "new-namespace",
    family: "layout",
    title: "a whole new namespace folder `stg` added by copying prd",
    mutate: (f) =>
      ["prd", "prd/black", "prd/yellow"].reduce(
        (acc, from) => cloneFolder(acc, from, from.replace(/^prd/, "stg"), (t) => t.replace(/environment: prd/g, "environment: stg")),
        f
      ),
  },
  {
    id: "dashed-namespace",
    family: "layout",
    title: "namespace `team-dev` beside `dev` (Application names end in the last dash segment)",
    mutate: (f) => cloneFolder(f, "dev", "team-dev"),
  },
  {
    id: "folder-without-defaults",
    family: "layout",
    title: "a folder with values/ but no defaults.yaml (the root generator never deploys it)",
    mutate: (f) => put(f, "qa/values/ms2.yaml", "image:\n  repository: registry.example.org/ms2\n  tag: 9.9.9\n"),
  },
  {
    id: "orphan-values-file",
    family: "layout",
    title: "a values file with no matching base file",
    mutate: (f) => put(f, "dev/values/ghost.yaml", "image:\n  repository: registry.example.org/ghost\n  tag: 1.0.0\n"),
  },
  {
    id: "base-only-release",
    family: "layout",
    title: "a release in base/ that no folder runs",
    mutate: (f) => put(f, "base/ms3.yaml", "workload:\n  type: deployment\nimage:\n  repository: registry.example.org/ms3\n  tag: 1.0.0\n"),
  },
  {
    id: "yml-extension",
    family: "layout",
    title: "a values file named .yml (the `*.yaml` glob skips it)",
    mutate: (f) => move(f, "prd/values/ms2.yaml", "prd/values/ms2.yml"),
  },
  {
    id: "uppercase-underscore-release",
    family: "layout",
    title: "a release file named `Payment_API.yaml` in base and in dev/values",
    mutate: (f) =>
      put(
        put(f, "base/Payment_API.yaml", "workload:\n  type: deployment\nservice:\n  enabled: true\n  ports:\n    http:\n      port: 8080\n"),
        "dev/values/Payment_API.yaml",
        "image:\n  repository: registry.example.org/payment\n  tag: 2.0.0\n"
      ),
  },
  {
    id: "dotted-release",
    family: "layout",
    title: "a release file named `ms2.v2.yaml`",
    mutate: (f) => put(put(f, "base/ms2.v2.yaml", get(f, "base/ms2.yaml")!), "dev/values/ms2.v2.yaml", get(f, "dev/values/ms2.yaml")!),
  },
  {
    id: "stray-files",
    family: "layout",
    title: "README.md, .gitkeep, ms1.yaml.bak and notes.txt scattered through the tree",
    mutate: (f) =>
      [
        ["dev/README.md", "# dev\n"],
        ["dev/values/.gitkeep", ""],
        ["dev/black/values/ms1.yaml.bak", "replicaCount: 7\n"],
        ["notes.txt", "todo\n"],
        ["docs/runbook.md", "# runbook\n"],
      ].reduce((acc, [p, t]) => put(acc, p, t), f),
  },
  {
    id: "base-defaults-file",
    family: "layout",
    title: "a base/defaults.yaml (looks like shared defaults; is a release to base/ and a folder to the root generator)",
    mutate: (f) => put(f, "base/defaults.yaml", "replicaCount: 2\n"),
  },
  {
    id: "duplicate-release-in-two-groups",
    family: "layout",
    title: "dev/values/a/ms2.yaml and dev/values/b/ms2.yaml (two Applications named ms2-dev)",
    mutate: (f) => put(move(f, "dev/values/ms2.yaml", "dev/values/a/ms2.yaml"), "dev/values/b/ms2.yaml", "replicaCount: 2\n"),
  },
  {
    id: "values-dir-without-files",
    family: "layout",
    title: "a namespace whose values/ is empty except a .gitkeep (deploys nothing, keeps its ApplicationSet)",
    mutate: (f) => put(put(f, "ops/defaults.yaml", "environment: ops\n"), "ops/values/.gitkeep", ""),
  },
  {
    id: "no-root-files",
    family: "layout",
    title: "the root Application / ApplicationSet files deleted",
    mutate: (f) => f.filter((x) => !x.path.startsWith("root")),
  },
  {
    id: "legacy-root-spelling",
    family: "layout",
    title: "root files under the older `root-applicationSet.yaml` / `root-application.yaml` names",
    mutate: (f) =>
      f.map((x) => (x.path === "rootApplicationSet.yaml" ? { ...x, path: "root-applicationSet.yaml" } : x.path === "rootApplication.yaml.txt" ? { ...x, path: "root-application.yaml" } : x)),
  },

  // ======================= combined ===========================================
  {
    id: "kitchen-sink",
    family: "combined",
    title: "CRLF + BOM + comments + a deeper variant + a grouped sub-folder + null-delete + yes-boolean, all at once",
    mutate: (f) => {
      let g = move(f, "dev/values/ms2.yaml", "dev/values/team-a/ms2.yaml");
      g = underEnv(g, "dev/black/values/ms1.yaml", "  COLOR: null\n");
      g = append(g, "prd/values/ms2.yaml", "\nautoscaling:\n  enabled: yes\n");
      g = cloneFolder(g, "prd/black", "prd/black/eu");
      g = editAll(g, isYaml, (t) => `\uFEFF# edited by hand\n${t}`.replace(/\n/g, "\r\n"));
      return g;
    },
  },
];

/** Two copies of base/ms2.yaml under the group paths given, so both chart layouts can read it. */
const groupBase = (f: Files, groups: string[]) => groups.reduce((acc, g) => put(acc, `base/${g}/ms2.yaml`, get(f, "base/ms2.yaml")!), f);
const bigFile = (n: number) => `\nbulk:\n${Array.from({ length: n }, (_, i) => `  key_${String(i).padStart(4, "0")}: value-${i}`).join("\n")}\n`;

/** The second hundred's worth: 39 more, same families, aimed at what the first 61 did not reach. */
const MORE_CASES: Case[] = [
  // ---- types
  {
    id: "big-and-negative-ints",
    family: "types",
    title: "integers past 2^53, negatives and a 30-digit number (JavaScript cannot hold the big ones exactly)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\ntuning:\n  neg: -5\n  big: 9007199254740993\n  huge: 123456789012345678901234567890\n"),
  },
  {
    id: "odd-floats",
    family: "types",
    title: "floats written 1e-3, -0.0, .5, 5. and 1.20",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\ntuning:\n  tiny: 1e-3\n  negzero: -0.0\n  half: .5\n  five: 5.\n  trailing: 1.20\n"),
  },
  {
    id: "trap-keys",
    family: "types",
    title: "map keys on, y, null, \"true\" and \"1\" (Helm reads a bare on:/y: key as true)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", '\nflags:\n  on: a\n  "y": b\n  "null": c\n  "true": d\n  "1": e\n'),
  },
  {
    id: "dotted-and-slashed-keys",
    family: "types",
    title: "annotation keys with dots and slashes (example.com/team, a.b.c)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\npodAnnotations:\n  example.com/team: core\n  a.b.c: d\n  prometheus.io/scrape: 'true'\n"),
  },
  {
    id: "trap-values-in-lists",
    family: "types",
    title: "a list mixing y, \"n\", 0x10, \"0x10\", on and \"08\"",
    mutate: (f) => append(f, "dev/values/ms2.yaml", '\nargs:\n- y\n- "n"\n- 0x10\n- "0x10"\n- on\n- "08"\n'),
  },
  {
    id: "radix-ints",
    family: "types",
    title: "0xFF, 0b1010 and 0o17 unquoted",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\ntuning:\n  hex: 0xFF\n  bin: 0b1010\n  oct: 0o17\n"),
  },
  {
    id: "numeric-keys",
    family: "types",
    title: "map keys 80 and \"443\" (numbers as keys)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", '\nbyPort:\n  80: http\n  "443": https\n'),
  },
  {
    id: "timestamps",
    family: "types",
    title: "an RFC 3339 timestamp and a date, unquoted (strings to Helm)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\nschedule:\n  when: 2024-01-01T10:00:00Z\n  day: 2024-01-01\n"),
  },
  {
    id: "zero-padded-strings",
    family: "types",
    title: "\"000123\" and \"1.20\" quoted, 007 unquoted (octal 7)",
    mutate: (f) => append(f, "dev/values/ms2.yaml", '\ntuning:\n  zeros: "000123"\n  version: "1.20"\n  agent: 007\n'),
  },
  {
    id: "awkward-keys",
    family: "types",
    title: "keys with a space, a colon, a leading # and a leading dash",
    mutate: (f) => append(f, "dev/values/ms2.yaml", '\nodd:\n  "a key": 1\n  "k:v": 2\n  "#hash": 3\n  "-dash": 4\n'),
  },

  // ---- semantics
  { id: "null-in-defaults", family: "semantics", title: "a namespace defaults.yaml setting replicaCount: null", mutate: (f) => append(f, "prd/defaults.yaml", "\nreplicaCount: null\n") },
  {
    id: "null-in-list-of-maps",
    family: "semantics",
    title: "a toleration whose value is null",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\ntolerations:\n- key: dedicated\n  operator: Exists\n  value: null\n"),
  },
  {
    id: "empty-strings",
    family: "semantics",
    title: "nameOverride: \"\" over base, and an empty annotation",
    mutate: (f) => append(append(f, "base/ms2.yaml", "\nnameOverride: ms2-named\n"), "prd/values/ms2.yaml", '\nnameOverride: ""\npodAnnotations:\n  empty: ""\n'),
  },
  {
    id: "multiline-trailing-spaces",
    family: "semantics",
    title: "a multi-line string whose lines end in spaces",
    mutate: (f) => append(f, "dev/values/ms2.yaml", '\nscript: "line one  \\nline two \\n"\n'),
  },
  {
    id: "tpl-in-keys",
    family: "semantics",
    title: "a templated annotation KEY in base ({{ .Values.color }}-team)",
    mutate: (f) => append(f, "base/ms1.yaml", "\npodAnnotations:\n  '{{ .Values.color }}-team': checkout\n"),
  },
  {
    id: "group-value-only-in-variant",
    family: "semantics",
    title: "a group value (tier) only one variant's defaults.yaml sets, read by its values file",
    mutate: (f) => append(append(f, "prd/yellow/defaults.yaml", "\ntier: gold\n"), "prd/yellow/values/ms1.yaml", "\npodLabels:\n  tier: '{{ .Values.tier }}'\n"),
  },
  {
    id: "values-restate-defaults",
    family: "semantics",
    title: "defaults.yaml and the values file both set replicaCount: 2",
    mutate: (f) => append(edit(f, "prd/values/ms2.yaml", (t) => t.replace(/replicaCount: \d+/, "replicaCount: 2")), "prd/defaults.yaml", "\nreplicaCount: 2\n"),
  },
  {
    id: "deep-empty-collections",
    family: "semantics",
    title: "empty maps and lists four levels down",
    mutate: (f) => append(f, "dev/values/ms2.yaml", "\naffinity:\n  nodeAffinity: {}\nextra:\n  a:\n    b:\n      c: []\n      d: {}\n"),
  },
  {
    id: "list-overridden-by-map",
    family: "semantics",
    title: "base sets args as a list, a folder replaces it with a map",
    mutate: (f) => append(append(f, "base/ms2.yaml", "\nargs:\n- --a\n"), "dev/values/ms2.yaml", "\nargs:\n  x: 1\n"),
  },
  {
    id: "map-overridden-by-scalar",
    family: "semantics",
    title: "base sets podAnnotations as a map, a folder replaces it with a string",
    mutate: (f) => append(append(f, "base/ms2.yaml", "\npodAnnotations:\n  a: b\n"), "dev/values/ms2.yaml", "\npodAnnotations: none\n"),
  },
  {
    id: "deeply-nested",
    family: "semantics",
    title: "a value eight maps deep, overridden in a folder",
    mutate: (f) =>
      append(
        append(f, "base/ms2.yaml", "\ndeep:\n  l1:\n    l2:\n      l3:\n        l4:\n          l5:\n            l6:\n              l7: base\n"),
        "prd/values/ms2.yaml",
        "\ndeep:\n  l1:\n    l2:\n      l3:\n        l4:\n          l5:\n            l6:\n              l7: prd\n"
      ),
  },
  { id: "large-values-file", family: "semantics", title: "a values file with 2 000 keys", mutate: (f) => append(f, "dev/values/ms2.yaml", bigFile(2000)) },

  // ---- layout
  {
    id: "two-level-groups",
    family: "layout",
    title: "dev/values/team/sub/ms2.yaml, its base at both base/ms2.yaml and base/team/sub/ms2.yaml",
    mutate: (f) => groupBase(move(f, "dev/values/ms2.yaml", "dev/values/team/sub/ms2.yaml"), ["team/sub"]),
  },
  {
    id: "release-only-in-a-variant",
    family: "layout",
    title: "a release (ms4) that only prd/black runs",
    mutate: (f) => put(put(f, "base/ms4.yaml", "workload:\n  type: deployment\nimage:\n  repository: registry.example.org/ms4\n"), "prd/black/values/ms4.yaml", "image:\n  tag: 4.0.0\n"),
  },
  {
    id: "same-release-three-groups",
    family: "layout",
    title: "ms2 in three different groups across three folders, with a base for each",
    mutate: (f) =>
      groupBase(
        put(move(move(f, "dev/values/ms2.yaml", "dev/values/a/ms2.yaml"), "prd/values/ms2.yaml", "prd/values/b/ms2.yaml"), "stg/values/c/ms2.yaml", "replicaCount: 1\n"),
        ["a", "b", "c"]
      ).concat([{ path: "stg/defaults.yaml", text: "environment: stg\n" }]),
  },
  {
    id: "yml-beside-yaml",
    family: "layout",
    title: "dev/values/ms2.yml beside dev/values/ms2.yaml",
    mutate: (f) => put(f, "dev/values/ms2.yml", "replicaCount: 5\n"),
  },
  { id: "base-yaml-not-a-release", family: "layout", title: "a base/README.yaml (an invalid release name nobody runs)", mutate: (f) => put(f, "base/README.yaml", "note: not a release\n") },
  { id: "folder-with-only-defaults", family: "layout", title: "a qa/defaults.yaml with no values/ (an ApplicationSet with no Applications)", mutate: (f) => put(f, "qa/defaults.yaml", "environment: qa\n") },
  {
    id: "four-level-variant",
    family: "layout",
    title: "prd/yellow/eu/west with its own defaults.yaml",
    mutate: (f) => cloneFolder(f, "prd/yellow", "prd/yellow/eu/west", (t) => (t.includes("color:") ? `${t}\nregion: eu-west\n` : t)),
  },
  {
    id: "uppercase-folder",
    family: "layout",
    title: "a folder named Prd (not a valid namespace)",
    mutate: (f) => cloneFolder(f, "prd", "Prd"),
  },
  {
    id: "release-named-defaults",
    family: "layout",
    title: "a release called `defaults` (base/defaults.yaml + dev/values/defaults.yaml)",
    mutate: (f) => put(put(f, "base/defaults.yaml", "workload:\n  type: deployment\n"), "dev/values/defaults.yaml", "replicaCount: 1\n"),
  },
  {
    id: "group-named-values",
    family: "layout",
    title: "a grouping sub-folder called `values` (dev/values/values/ms2.yaml)",
    mutate: (f) => groupBase(move(f, "dev/values/ms2.yaml", "dev/values/values/ms2.yaml"), ["values"]),
  },

  // ---- wiring
  {
    id: "root-list-generator",
    family: "layout",
    title: "the root ApplicationSet uses a list generator instead of the git one",
    mutate: (f) => edit(f, "rootApplicationSet.yaml", (t) => t.replace(/  - git:\n[\s\S]*?(?=\n  goTemplate|\n  template)/, "  - list:\n      elements:\n      - path: dev\n")),
  },
  {
    id: "root-origin-path",
    family: "layout",
    title: "the root ApplicationSet's originPath set to envs",
    mutate: (f) => edit(f, "rootApplicationSet.yaml", (t) => t.replace(/name: originPath\n(\s+)value: .*/, "name: originPath\n$1value: envs").replace(/(\s+)- name: originBranch/, "$1- name: originPath$1  value: envs$1- name: originBranch")),
  },
  { id: "root-appset-unreadable", family: "layout", title: "rootApplicationSet.yaml that is not YAML", mutate: (f) => put(f, "rootApplicationSet.yaml", "{{ broken\n  - : :\n") },
  {
    id: "extra-root-yaml",
    family: "layout",
    title: "kustomization.yaml and app-project.yaml at the repo root",
    mutate: (f) => put(put(f, "kustomization.yaml", "resources: [rootApplicationSet.yaml]\n"), "app-project.yaml", "kind: AppProject\n"),
  },

  // ---- combined
  {
    id: "kitchen-sink-2",
    family: "combined",
    title: "CRLF + trap keys + nulls + a .yml + an orphan values file",
    mutate: (f) => {
      let g = append(f, "dev/values/ms2.yaml", '\nflags:\n  on: a\n  "y": b\nservice: null\n');
      g = put(put(g, "prd/values/ms2.yml", "x: 1\n"), "dev/values/ghost.yaml", "image:\n  tag: 1\n");
      return editAll(g, isYaml, (t) => t.replace(/\n/g, "\r\n"));
    },
  },
  {
    id: "kitchen-sink-3",
    family: "combined",
    title: "comments + a dotted release + two-level groups + big ints",
    mutate: (f) => {
      let g = put(put(f, "base/ms2.v2.yaml", get(f, "base/ms2.yaml")!), "dev/values/ms2.v2.yaml", "tuning:\n  big: 9007199254740993\n");
      g = groupBase(move(g, "prd/values/ms2.yaml", "prd/values/x/y/ms2.yaml"), ["x/y"]);
      return editAll(g, isYaml, (t) => `# hand edited\n${t}`);
    },
  },
  {
    id: "every-values-file-unreadable",
    family: "combined",
    title: "every namespace values file broken (unterminated quote)",
    mutate: (f) => editAll(f, (p) => /\/values\/.+\.yaml$/.test(p), (t) => `${t}\nbroken: "unterminated\n`),
  },
];

/** All 100. */
export const CASES: Case[] = [...FIRST_CASES, ...MORE_CASES];

/**
 * Seeded random formatting chaos: the same values, re-spelled — comments, CRLF,
 * markers, indentation, reordering — in a different combination per seed. Every
 * one must deploy exactly what the seed tree deploys.
 */
export function fuzzCase(seed: number): Case {
  let s = (seed * 2654435761) % 2 ** 32 || 1;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  // Only the pure re-spellings — the anchors / block-scalar cases add keys. They
  // run in this order whatever was picked: structure first, then the byte-level
  // ones, CRLF last so no later rewrite has to know about `\r`.
  const order = [
    "key-order-reversed",
    "flow-style",
    "quoted-everything",
    "indent-4",
    "comments-everywhere",
    "no-trailing-newline-and-trailing-spaces",
    "doc-end-marker",
    "doc-start-marker",
    "bom",
    "crlf",
  ];
  const picked = order.filter(() => rnd() < 0.35).map((id) => CASES.find((c) => c.id === id)!);
  return {
    id: `fuzz-${seed}`,
    family: "fuzz",
    title: picked.map((c) => c.id).join(" + ") || "(no-op)",
    mutate: (f) => picked.reduce((acc, c) => c.mutate(acc), f),
  };
}
