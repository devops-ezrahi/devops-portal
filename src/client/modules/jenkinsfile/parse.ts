import { KIND_LABEL, STEPS, stepSpec, type ArgKind } from "./catalog";
import { PARAM_TYPES } from "./params";
import { createStage, newPipeline, stageId, type DraftPipeline } from "./pipeline";
import { newParam } from "./params";
import type { JenkinsfileParam, JenkinsfileStage } from "../../../server/types";

/**
 * Reads an existing Jenkinsfile back into the builder.
 *
 * This is not a Groovy parser and does not try to be one: it is the inverse of
 * `groovy.ts` for the shapes the library actually uses — an `@Library` line, a
 * `properties([parameters([…])])` block, and a flat run of top-level step calls
 * with a named-argument map. Anything it does not recognise is reported rather
 * than dropped silently, because a stage that vanishes without a word is worse
 * than one the user has to re-add by hand.
 */
export type ImportResult = { pipeline: DraftPipeline; warnings: string[] };

type Value =
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: number }
  | { t: "list"; v: Value[] }
  | { t: "map"; v: [string, Value][] }
  | { t: "closure"; v: string }
  | { t: "call"; name: string; args: Value[]; src: string }
  | { t: "expr"; v: string };

const IDENT = /[A-Za-z_$][A-Za-z0-9_$.]*/y;

/**
 * The index just past the string literal that opens at `i`. Every scan below
 * skips strings through this one function, because a GString's `${…}` may hold
 * quotes of its own — `"${ok ? "PRD" : 'dev'}"`, `"${xs.join(",")}"` — and
 * ending the string at the first inner quote left that comma outside it.
 */
function stringEnd(src: string, i: number): number {
  const c = src[i];
  const quote = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
  let j = i + quote.length;
  while (j < src.length && !src.startsWith(quote, j)) {
    if (src[j] === "\\") j += 2;
    else if (c === '"' && src.startsWith("${", j)) j = matchBracket(src, j + 1, "{", "}").next;
    else j += 1;
  }
  return Math.min(j + quote.length, src.length);
}

/**
 * Comments have to go before anything else scans the source, but a `//` inside
 * a string is not a comment — so this walks the text in the same string-aware
 * way the value reader does rather than running a regex over it.
 */
export function stripComments(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const end = stringEnd(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function skipSpace(src: string, i: number): number {
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return i;
}

/** The body of a bracketed run, given the index of its opening bracket. */
function matchBracket(src: string, start: number, open: string, close: string): { body: string; next: number } {
  let depth = 0;
  for (let i = start; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = stringEnd(src, i);
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return { body: src.slice(start + 1, i), next: i + 1 };
    }
    i += 1;
  }
  // Unbalanced — take the rest and let the caller's parse of it do what it can.
  return { body: src.slice(start + 1), next: src.length };
}

const ESCAPES: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t", r: "\r" };

/**
 * A string literal's value, in the one form the builder holds every string in:
 * `${…}` is an interpolation and everything else is literal text — which is
 * what `quote` in groovy.ts writes back. So this has to read the way Groovy
 * does: a single-quoted `${f}` is literal (the *shell* variable in `sh 'echo
 * ${f}'`) and is held escaped as `\${f}`; a double-quoted `$VERSION` is
 * interpolated and becomes `${VERSION}`; `\$` is a plain `$` and `\n` a newline.
 */
function readString(src: string, i: number): { value: string; next: number } {
  const c = src[i];
  const quote = src.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
  const gstring = c === '"';
  let j = i + quote.length;
  let out = "";
  while (j < src.length && !src.startsWith(quote, j)) {
    const dollar = gstring && src[j] === "$" ? /^\$([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/.exec(src.slice(j, j + 200)) : null;
    if (src[j] === "\\" && j + 1 < src.length) {
      // `\${` stays escaped, since that is how a literal `${` is held. An
      // escape Groovy does not have keeps its backslash, which is what a regex
      // or a Windows path in there wants.
      const n = src[j + 1];
      out += n === "$" ? (src[j + 2] === "{" ? "\\$" : "$") : (ESCAPES[n] ?? `\\${n}`);
      j += 2;
    } else if (src.startsWith("${", j)) {
      const next = gstring ? matchBracket(src, j + 1, "{", "}").next : j + 2;
      out += gstring ? src.slice(j, next) : "\\${";
      j = next;
    } else if (dollar) {
      out += `\${${dollar[1]}}`;
      j += dollar[0].length;
    } else {
      out += src[j];
      j += 1;
    }
  }
  return { value: out, next: j + quote.length };
}

/** Splits a comma-separated run at depth 0, respecting strings and brackets. */
function splitTop(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = stringEnd(src, i);
      continue;
    }
    if (c === "[" || c === "(" || c === "{") depth += 1;
    else if (c === "]" || c === ")" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The key of a `key: value` entry, or null when the entry is positional. */
function splitEntry(src: string): { key: string | null; value: string } {
  let depth = 0;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const end = stringEnd(src, i);
      // A quoted key is legal: 'my-key': 'v'.
      const after = skipSpace(src, end);
      if (depth === 0 && src[after] === ":") {
        return { key: readString(src, i).value, value: src.slice(after + 1) };
      }
      i = end;
      continue;
    }
    if (c === "[" || c === "(" || c === "{") depth += 1;
    else if (c === "]" || c === ")" || c === "}") depth -= 1;
    // `::` is a method reference and `?:` an elvis, neither of which is an entry
    // key; a bare `:` at depth 0 after an identifier is.
    else if (c === ":" && depth === 0 && src[i + 1] !== ":" && src[i - 1] !== "?") {
      const key = src.slice(0, i).trim();
      if (new RegExp(`^${IDENT.source}$`).test(key)) return { key, value: src.slice(i + 1) };
    }
    i += 1;
  }
  return { key: null, value: src };
}

export function readValue(raw: string): Value {
  const src = raw.trim();
  if (!src) return { t: "expr", v: "" };
  const c = src[0];

  if (c === "'" || c === '"') {
    const { value, next } = readString(src, 0);
    // Only a lone literal is a string; `'a' + b` is an expression.
    if (skipSpace(src, next) >= src.length) return { t: "str", v: value };
    return { t: "expr", v: src };
  }
  if (c === "{") return { t: "closure", v: matchBracket(src, 0, "{", "}").body };
  if (c === "[") {
    const entries = splitTop(matchBracket(src, 0, "[", "]").body);
    // `[:]` is Groovy's empty map; `[]` an empty list. Otherwise the first
    // entry decides, exactly as Groovy itself does.
    if (src.replace(/\s/g, "") === "[:]") return { t: "map", v: [] };
    const split = entries.map(splitEntry);
    if (split.length && split.every((e) => e.key !== null)) {
      return { t: "map", v: split.map((e) => [e.key!, readValue(e.value)] as [string, Value]) };
    }
    return { t: "list", v: entries.map(readValue) };
  }
  if (src === "true" || src === "false") return { t: "bool", v: src === "true" };
  if (/^-?\d+(\.\d+)?$/.test(src)) return { t: "num", v: Number(src) };

  IDENT.lastIndex = 0;
  const m = IDENT.exec(src);
  if (m && src[skipSpace(src, m[0].length)] === "(") {
    const open = skipSpace(src, m[0].length);
    const { body, next } = matchBracket(src, open, "(", ")");
    if (skipSpace(src, next) >= src.length) {
      return { t: "call", name: m[0], args: callArgs(body), src };
    }
  }
  return { t: "expr", v: src };
}

/**
 * A call's arguments. Groovy collects the named ones into a single Map passed
 * first — `booleanParam(name: 'x', defaultValue: true)` is one map, not two
 * arguments — so they are grouped here the same way, which is what lets
 * `paramFrom` read them off one value.
 */
function callArgs(body: string): Value[] {
  const named: [string, Value][] = [];
  const positional: Value[] = [];
  for (const part of splitTop(body)) {
    const { key, value } = splitEntry(part);
    if (key === null) positional.push(readValue(value));
    else named.push([key, readValue(value)]);
  }
  return named.length ? [{ t: "map", v: named }, ...positional] : positional;
}

const CONTINUES_LINE = /(,|=|\+|&&|\|\||\?|->)$/;
const OPENS_CONTINUATION = /\s*(\{|\.|\?|:|&&|\|\||else\b|catch\b|finally\b)/y;

/**
 * The statements of a run of Groovy, in source order. One ends at a newline or
 * `;` outside any bracket — unless the text carries on: a line ending in a comma
 * or an operator, or a next line opening with `{`, `.`, `else`, `catch` and the
 * like. Reading statements rather than hunting for calls is what lets anything
 * that is *not* a step call be named instead of skipped over without a word.
 */
function statements(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"') {
      i = stringEnd(src, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (depth <= 0 && (c === ";" || c === "\n")) {
      const text = src.slice(start, i).trim();
      OPENS_CONTINUATION.lastIndex = i + 1;
      if (c === ";" || !(CONTINUES_LINE.test(text) || OPENS_CONTINUATION.test(src))) {
        if (text) out.push(text);
        start = i + 1;
      }
    }
    i += 1;
  }
  const last = src.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** The calls the reader takes: every library step, plus the two it handles itself. */
const READ = new Set([...STEPS.filter((s) => s.callStyle !== "raw").map((s) => s.step), "parallel", "properties"]);

/**
 * A statement that is exactly one call, or null. Takes Groovy's
 * parenthesis-free form too — `sleep 30`, `parallel a: {…}` — but only for a
 * name the reader knows, so `return x` or `echo 'y'` is never mistaken for one.
 */
function callOf(text: string): { name: string; body: string } | null {
  IDENT.lastIndex = 0;
  const m = IDENT.exec(text);
  if (!m) return null;
  const open = skipSpace(text, m[0].length);
  if (text[open] === "(") {
    const { body, next } = matchBracket(text, open, "(", ")");
    return skipSpace(text, next) >= text.length ? { name: m[0], body } : null;
  }
  if (READ.has(m[0]) && open > m[0].length && open < text.length && !/[=.+\-*/<>!?:&|]/.test(text[open])) {
    return { name: m[0], body: text.slice(open) };
  }
  return null;
}

/** A statement or value squeezed onto one short line — enough to find it in the file. */
function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const STEP_CALL = new RegExp(`\\b(${[...READ].filter((s) => stepSpec(s)).join("|")})\\s*\\(`);

/** `vars/` files the library's own steps call. They are the library's, but not steps anyone builds a pipeline from. */
const HELPERS = ["errorStage", "skipStage", "podLauncher", "nodeExecutor"];

/** Why a top-level statement was not imported — naming any library step it hid. */
function skipped(text: string): string {
  const call = callOf(text);
  const why = /^pipeline\s*\{/.test(text)
    ? "this looks like a declarative pipeline (pipeline { … }). The builder writes scripted files that call the shared library's steps, so its stages could not be read"
    : !call
      ? "the builder reads step calls, not the Groovy wrapped around them"
      : HELPERS.includes(call.name)
        ? "a helper the library's own steps call, which the builder has no card for"
        : "not a step in the shared library";
  const inside = [...new Set([...text.matchAll(new RegExp(STEP_CALL, "g"))].map((m) => `${m[1]}()`))];
  const held = inside.length
    ? ` It holds ${inside.join(", ")}, which only become${inside.length === 1 ? "s a card" : " cards"} when called at the top level.`
    : "";
  return `Skipped \`${excerpt(text)}\` — ${why}.${held}`;
}

/** A parsed value as the plain text a single-line field holds. */
function asText(value: Value): string {
  switch (value.t) {
    case "str":
      return value.v;
    case "bool":
    case "num":
      return String(value.v);
    // Groovy standing where a string goes — a variable, a ternary, a call — is
    // held as the GString that interpolates it, which is the same value. Taken
    // as its own text instead, `image: DEFAULT_IMAGE` came back as the image
    // literally named 'DEFAULT_IMAGE'.
    case "expr":
      return value.v ? `\${${value.v}}` : "";
    case "call":
      return `\${${value.src}}`;
    default:
      return "";
  }
}

function asLines(value: Value): string[] {
  if (value.t === "list") return value.v.map(asText);
  if (value.t === "str") return [value.v];
  return [];
}

/**
 * A closure body arrives indented to wherever the call sat in the file. The
 * editor holds what the user typed, so the common leading whitespace comes off
 * — otherwise every round trip indents the body one level deeper than the last.
 */
function dedent(body: string): string {
  const lines = body.replace(/^\n/, "").trimEnd().split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(common)).join("\n");
}

function asPairs(value: Value): [string, string][] {
  if (value.t === "map") return value.v.map(([k, v]) => [k, asText(v)] as [string, string]);
  return [];
}

/**
 * Whether a field of this kind can hold what was read. A flag, a number, a list
 * or a list of entries has nowhere to put Groovy that computes one —
 * `unshallow: isRelease`, `flags: MVN_FLAGS` — so that argument comes in empty,
 * and the caller says so.
 */
function fits(kind: ArgKind, value: Value): boolean {
  switch (kind) {
    case "boolean":
      return value.t === "bool" || (value.t === "str" && /^(true|false)$/.test(value.v));
    case "integer":
      return value.t === "num" || (value.t === "str" && /^\d+$/.test(value.v.trim()));
    case "stringList":
      return value.t === "list" || value.t === "str";
    case "commands":
      return value.t === "list" || value.t === "str" || value.t === "closure";
    case "objectList":
      return value.t === "map" || (value.t === "list" && value.v.every((entry) => entry.t === "map"));
    case "stringMap":
      return value.t !== "closure" && value.t !== "str" && !(value.t === "list" && value.v.length);
    default:
      return value.t !== "closure" && value.t !== "list" && value.t !== "map";
  }
}

/** One parsed argument, shaped the way the editor and generator hold that kind. */
function coerce(kind: ArgKind, value: Value): unknown {
  switch (kind) {
    case "boolean":
      return value.t === "bool" ? value.v : asText(value) === "true";
    case "integer":
      return value.t === "num" ? value.v : Number(asText(value)) || "";
    case "expression":
      // Raw Groovy either way — a quoted string here would lose its quotes on
      // the way back out, so a literal keeps them.
      return value.t === "str" ? `'${value.v}'` : value.t === "call" ? value.src : value.t === "expr" ? value.v : asText(value);
    case "stringList":
      return asLines(value);
    case "commands":
      return value.t === "closure" ? { closure: dedent(value.v) } : asLines(value);
    case "stringMap":
      // A variable (`populateEnvVars(envs)`, `def envs = [...]` above) or a
      // call is kept as the Groovy it is, and written back verbatim.
      return value.t === "expr" ? value.v : value.t === "call" ? value.src : asPairs(value);
    case "objectList":
      return value.t === "list"
        ? value.v.map((entry) => Object.fromEntries(asPairs(entry)))
        : value.t === "map"
          ? [Object.fromEntries(asPairs(value))]
          : [];
    default:
      return asText(value);
  }
}

function paramFrom(call: Value): JenkinsfileParam | null {
  if (call.t !== "call") return null;
  const spec = PARAM_TYPES.find((t) => t.fn === call.name);
  if (!spec) return null;

  const fields = new Map<string, Value>();
  for (const arg of call.args) {
    if (arg.t === "map") for (const [k, v] of arg.v) fields.set(k, v);
  }
  const name = fields.get("name");
  if (!name) return null;

  const choices = fields.get("choices");
  const defaultValue = fields.get("defaultValue");
  return {
    ...newParam(),
    name: asText(name),
    type: spec.type,
    description: asText(fields.get("description") ?? { t: "str", v: "" }),
    // Every type stores its default as a string, booleans included.
    defaultValue: defaultValue ? asText(defaultValue) : "",
    // The older form is one newline-separated string: choices: "a\nb".
    ...(spec.type === "choice"
      ? { choices: choices?.t === "str" ? choices.v.split("\n") : choices ? asLines(choices) : [] }
      : {}),
  };
}

/**
 * `properties([parameters([...])])` — the arguments arrive nested two lists
 * deep, so this digs for the `parameters` call rather than assuming a shape.
 * Whatever else sits in there (`buildDiscarder`, `pipelineTriggers`) is a job
 * property the builder does not keep, and is named as one.
 */
function paramsFrom(body: string, warnings: string[]): JenkinsfileParam[] {
  const found: JenkinsfileParam[] = [];
  function walk(value: Value) {
    if (value.t === "list") return value.v.forEach(walk);
    if (value.t === "call" && value.name === "parameters") return value.args.forEach(walk);
    const param = paramFrom(value);
    if (param) return found.push(param);
    const text = excerpt(value.t === "call" ? value.src : value.t === "expr" ? value.v : JSON.stringify(value.v));
    warnings.push(
      value.t === "call" && PARAM_TYPES.some((t) => t.fn === value.name)
        ? `properties: skipped \`${text}\` — a parameter with no name`
        : `properties: skipped \`${text}\` — only the parameters are read, so this job property will not be written back`
    );
  }
  splitTop(body).map(readValue).forEach(walk);
  return found;
}

function stageFrom(name: string, body: string, warnings: string[]): JenkinsfileStage | null {
  const spec = stepSpec(name);
  // `groovy` is the builder's own card, not something a file calls.
  if (!spec || spec.callStyle === "raw") return null;

  // Open, unlike a stage added by hand: an imported file is one you are reading.
  const stage = { ...createStage(name), collapsed: false };
  const entries = splitTop(body).map(splitEntry);

  // A `bare` step takes its one argument with no key in front of it —
  // populateEnvVars([SERVICE: 'x']) — so the first positional value is it.
  if (spec.callStyle === "bare") {
    const arg = spec.args[0];
    const keyed = entries.filter((e) => e.key !== null);
    const named = keyed.length === 1 && keyed[0].key === arg.name ? keyed[0] : null;
    let value: Value | null = null;
    if (named) value = readValue(named.value); // populateEnvVars(envVars: [...])
    // populateEnvVars(SERVICE: 'x', TEAM_NAME: 'y') — Groovy collects named
    // arguments into one map, so this is the same call as the bracketed form.
    else if (keyed.length) value = { t: "map", v: keyed.map((e) => [e.key!, readValue(e.value)] as [string, Value]) };
    else if (entries[0]) value = readValue(entries[0].value);
    if (value) {
      if (value.t !== "map" && value.t !== "expr" && value.t !== "call")
        warnings.push(`${name}: its argument is not a literal map, so it was left empty`);
      stage.args[arg.name] = coerce(arg.kind, value);
    }
    return stage;
  }

  entries.forEach(({ key, value }, n) => {
    // Jenkins' own steps take their first argument bare: `sleep 30`.
    const arg = key === null ? (spec.builtin && n === 0 ? spec.args[0] : undefined) : spec.args.find((a) => a.name === key);
    if (!arg) {
      warnings.push(
        key === null
          ? `${name}: ignored a positional argument — \`${excerpt(value)}\``
          : `${name}: ignored an argument the builder does not know — ${key}`
      );
      return;
    }
    const read = readValue(value);
    if (!fits(arg.kind, read)) {
      warnings.push(
        `${name}: ${arg.name} is \`${excerpt(value)}\`, which a ${KIND_LABEL[arg.kind]} field cannot hold — ` +
          `it came in ${arg.kind === "boolean" ? "as false" : "empty"}`
      );
    }
    stage.args[arg.name] = coerce(arg.kind, read);
  });
  return stage;
}

/**
 * `parallel('A': { genStage(…) }, 'B': { … })` — one box, one card per branch,
 * which is the shape the generator writes back.
 */
function parallelFrom(body: string, warnings: string[]): JenkinsfileStage[] {
  const stages: JenkinsfileStage[] = [];
  const group = `g-${stageId()}`;
  for (const { key, value } of splitTop(body).map(splitEntry)) {
    const branch = readValue(value);
    if (branch.t !== "closure") {
      warnings.push(
        `parallel: ignored \`${excerpt(key === null ? value : `${key}: ${value}`)}\` — only branches written out as { … } closures can be read`
      );
      continue;
    }
    const found: JenkinsfileStage[] = [];
    for (const text of statements(branch.v)) {
      const call = callOf(text);
      const stage = call && stageFrom(call.name, call.body, warnings);
      if (stage) found.push({ ...stage, group });
      else warnings.push(`parallel: in branch ${key} — ${skipped(text)}`);
    }
    if (found.length > 1)
      warnings.push(`parallel: branch ${key} runs ${found.length} steps in a row; each became its own parallel branch`);
    stages.push(...found);
  }
  return stages;
}

/**
 * What `splitDefs` lifts: `def`, `import` and `@Field` statements, and a
 * declaration by type — `final String X = …`, `String stamp() {`,
 * `List<String> MODS = […]`.
 */
const DECL =
  /^[ \t]*(?:(?:def|import|@Field)\b|(?:(?:final|static)\s+)*(?:void|[A-Z][\w.]*(?:<[^>\n]*>)?(?:\[\])?)\s+[A-Za-z_]\w*\s*[=(])/;

/** A lifted statement that assigns a value when it runs, rather than declaring a function or a field. */
const RUNS = /^\s*(?!import\b|@Field\b)[^(]*[^=!<>]=(?![=~])/;

/**
 * Top-level `def` variables and functions (plus `import` and `@Field` lines),
 * lifted out whole — a function body included — into the pipeline's Groovy
 * block. What is left is the calls the rest of the reader looks for.
 *
 * The block is written before every stage, so a variable assigned *after* one
 * is not lifted: above `semVerStage()`, `def v = env.VERSION` would read
 * nothing. It stays in `rest`, where it becomes a Groovy card in place.
 */
export function splitDefs(src: string): { defs: string; rest: string } {
  const defs: string[] = [];
  let rest = "";
  let depth = 0;
  let from = -1; // start of the statement being lifted, -1 when none
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (depth === 0 && from < 0 && (i === 0 || src[i - 1] === "\n") && DECL.test(src.slice(i, i + 200))) from = i;
    if (c === "'" || c === '"') {
      const end = stringEnd(src, i);
      if (from < 0) rest += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth += 1;
    if (c === "}" || c === "]" || c === ")") depth -= 1;
    if (from >= 0 && depth === 0 && (c === "\n" || i === src.length - 1)) {
      // `def f(x)` with its `{` on the next line still belongs to it.
      const after = src.slice(i + 1).match(/^\s*\{/);
      if (!after) {
        const text = src.slice(from, i + 1).trimEnd();
        // A variable assigned after a stage stays where it is — lifted, it
        // would run before the stage it reads from — and becomes a Groovy card.
        if (RUNS.test(text) && STEP_CALL.test(rest)) rest += src.slice(from, i + 1);
        else defs.push(text);
        from = -1;
        i += 1;
        continue;
      }
    }
    if (from < 0) rest += c;
    i += 1;
  }
  if (from >= 0) defs.push(src.slice(from).trimEnd());
  return { defs: defs.join("\n"), rest };
}

/**
 * Reads a whole Jenkinsfile. Always returns a pipeline: an unrecognisable file
 * gives an empty one plus the reasons, which is what the import dialog shows.
 */
export function parseJenkinsfile(text: string): ImportResult {
  const warnings: string[] = [];
  // A file saved on Windows carries \r\n, and every scan below splits on \n —
  // the \r then rode along into commands, Groovy cards and the round trip.
  const src = stripComments(text.replace(/\r\n?/g, "\n"));
  const pipeline = newPipeline();

  const library = /@Library\s*\(\s*(['"])([^'"]*)\1\s*\)/.exec(src);
  if (library) pipeline.library = library[2];
  else if (/@Library\b/.test(src))
    warnings.push("@Library: only one quoted library name can be read, so the import line was left out.");

  const { defs, rest } = splitDefs(src);
  pipeline.groovy = defs;

  for (const statement of statements(rest)) {
    // The annotation, its `_`, and a shebang are the file's framing, not steps.
    if (/^(@Library\b|#!|_$)/.test(statement)) continue;
    const call = callOf(statement);
    if (call?.name === "properties") {
      pipeline.params.push(...paramsFrom(call.body, warnings));
      continue;
    }
    // A parallel with no { … } branch written out — `parallel buildMatrix(mods)` —
    // has nothing to box; it falls through and is kept as Groovy.
    if (call?.name === "parallel" && splitTop(call.body).some((e) => readValue(splitEntry(e).value).t === "closure")) {
      pipeline.stages.push(...parallelFrom(call.body, warnings));
      continue;
    }
    const stage = call && stageFrom(call.name, call.body, warnings);
    if (stage) pipeline.stages.push(stage);
    else if (call?.name === "parameters") continue;
    // Not the builder's to rewrite: the builder writes scripted files.
    else if (/^pipeline\s*\{/.test(statement)) warnings.push(skipped(statement));
    else {
      // Anything else — an `if` around a stage, a helper's call, `node {}` — is
      // kept as Groovy right where it was, one card for a run of it.
      const last = pipeline.stages[pipeline.stages.length - 1];
      if (last?.step === "groovy") last.args.code = `${last.args.code}\n${statement}`;
      else pipeline.stages.push({ ...createStage("groovy"), args: { code: statement }, collapsed: false });
    }
  }

  if (!pipeline.stages.some((s) => s.step !== "groovy") && !warnings.length) {
    warnings.push(
      `No library steps found${pipeline.stages.length ? " — the file came in as Groovy" : ""}. The builder knows: ${[...READ]
        .filter((s) => stepSpec(s))
        .join(", ")}.`
    );
  }
  return { pipeline, warnings };
}
