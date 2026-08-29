import { STEPS, stepSpec, type ArgKind } from "./catalog";
import { PARAM_TYPES } from "./params";
import { createStage, newPipeline, type DraftPipeline } from "./pipeline";
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
  | { t: "call"; name: string; args: Value[] }
  | { t: "expr"; v: string };

const IDENT = /[A-Za-z_$][A-Za-z0-9_$.]*/y;

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
      const triple = src.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < src.length && !src.startsWith(quote, j)) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, Math.min(j + quote.length, src.length));
      i = j + quote.length;
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
      const triple = src.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < src.length && !src.startsWith(quote, j)) j += src[j] === "\\" ? 2 : 1;
      i = j + quote.length;
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

function readString(src: string, i: number): { value: string; next: number } {
  const c = src[i];
  const triple = src.startsWith(c.repeat(3), i);
  const quote = triple ? c.repeat(3) : c;
  let j = i + quote.length;
  let out = "";
  while (j < src.length && !src.startsWith(quote, j)) {
    if (src[j] === "\\" && j + 1 < src.length) {
      // Only the escapes the generator emits are unescaped; anything else keeps
      // its backslash, which is what a regex or a Windows path in there wants.
      const n = src[j + 1];
      out += n === "\\" || n === "'" || n === '"' ? n : `\\${n}`;
      j += 2;
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
      const triple = src.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < src.length && !src.startsWith(quote, j)) j += src[j] === "\\" ? 2 : 1;
      i = j + quote.length;
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
      const triple = src.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < src.length && !src.startsWith(quote, j)) j += src[j] === "\\" ? 2 : 1;
      // A quoted key is legal: 'my-key': 'v'.
      const after = skipSpace(src, j + quote.length);
      if (depth === 0 && src[after] === ":") {
        return { key: readString(src, i).value, value: src.slice(after + 1) };
      }
      i = j + quote.length;
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
      return { t: "call", name: m[0], args: callArgs(body) };
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

/** Top-level `name(...)` calls, in source order. */
function topLevelCalls(src: string): { name: string; body: string }[] {
  const calls: { name: string; body: string }[] = [];
  let depth = 0;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"') {
      const triple = src.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < src.length && !src.startsWith(quote, j)) j += src[j] === "\\" ? 2 : 1;
      i = j + quote.length;
      continue;
    }
    if (c === "{" || c === "[") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}" || c === "]") {
      depth -= 1;
      i += 1;
      continue;
    }
    // `@` excluded so the @Library annotation is not read as a call named Library.
    if (depth === 0 && /[A-Za-z_$]/.test(c) && !/[A-Za-z0-9_$.@]/.test(src[i - 1] ?? "")) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(src);
      if (m) {
        const open = skipSpace(src, i + m[0].length);
        if (src[open] === "(") {
          const { body, next } = matchBracket(src, open, "(", ")");
          calls.push({ name: m[0], body });
          i = next;
          continue;
        }
        i += m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return calls;
}

/** A parsed value as the plain text a single-line field holds. */
function asText(value: Value): string {
  switch (value.t) {
    case "str":
      return value.v;
    case "bool":
    case "num":
      return String(value.v);
    case "expr":
      return value.v;
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
      return value.t === "str" ? `'${value.v}'` : asText(value);
    case "stringList":
      return asLines(value);
    case "commands":
      return value.t === "closure" ? { closure: dedent(value.v) } : asLines(value);
    case "stringMap":
      return asPairs(value);
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
    ...(spec.type === "choice" ? { choices: choices ? asLines(choices) : [] } : {}),
  };
}

/**
 * `properties([parameters([...])])` — the arguments arrive nested two lists
 * deep, so this digs for the `parameters` call rather than assuming a shape.
 */
function paramsFrom(body: string, warnings: string[]): JenkinsfileParam[] {
  const found: JenkinsfileParam[] = [];
  function walk(value: Value) {
    if (value.t === "list") return value.v.forEach(walk);
    if (value.t !== "call") return;
    if (value.name === "parameters") return value.args.forEach(walk);
    const param = paramFrom(value);
    if (param) found.push(param);
    else warnings.push(`Skipped an unsupported parameter type: ${value.name}`);
  }
  splitTop(body).map(readValue).forEach(walk);
  return found;
}

function stageFrom(name: string, body: string, warnings: string[]): JenkinsfileStage | null {
  const spec = stepSpec(name);
  if (!spec) return null;

  // Open, unlike a stage added by hand: an imported file is one you are reading.
  const stage = { ...createStage(name), collapsed: false };
  const entries = splitTop(body).map(splitEntry);

  // A `bare` step takes its one argument with no key in front of it —
  // populateEnvVars([SERVICE: 'x']) — so the first positional value is it.
  if (spec.callStyle === "bare") {
    const first = entries[0];
    if (first) stage.args[spec.args[0].name] = coerce(spec.args[0].kind, readValue(first.value));
    return stage;
  }

  for (const { key, value } of entries) {
    if (key === null) {
      warnings.push(`${name}: ignored a positional argument`);
      continue;
    }
    const arg = spec.args.find((a) => a.name === key);
    if (!arg) {
      warnings.push(`${name}: ignored an argument the builder does not know — ${key}`);
      continue;
    }
    stage.args[arg.name] = coerce(arg.kind, readValue(value));
  }
  return stage;
}

/**
 * Reads a whole Jenkinsfile. Always returns a pipeline: an unrecognisable file
 * gives an empty one plus the reasons, which is what the import dialog shows.
 */
export function parseJenkinsfile(text: string): ImportResult {
  const warnings: string[] = [];
  const src = stripComments(text);
  const pipeline = newPipeline();

  const library = /@Library\s*\(\s*(['"])([^'"]*)\1\s*\)/.exec(src);
  if (library) pipeline.library = library[2];

  // A declarative file is a different language from what this builder writes:
  // its stages live inside `pipeline { stages { stage('x') { … } } }`, and none
  // of them are the library's steps. Say so rather than importing nothing.
  if (/^\s*pipeline\s*\{/m.test(src)) {
    warnings.push(
      "This looks like a declarative pipeline (pipeline { … }). The builder writes scripted files that call the shared library's steps, so its stages could not be read."
    );
  }

  for (const call of topLevelCalls(src)) {
    if (call.name === "properties") {
      pipeline.params.push(...paramsFrom(call.body, warnings));
      continue;
    }
    const stage = stageFrom(call.name, call.body, warnings);
    if (stage) pipeline.stages.push(stage);
    else if (call.name !== "parameters") {
      warnings.push(`Skipped ${call.name}() — not a step in the shared library.`);
    }
  }

  if (!pipeline.stages.length && !warnings.length) {
    warnings.push(`No library steps found. The builder knows: ${STEPS.map((s) => s.step).join(", ")}.`);
  }
  return { pipeline, warnings };
}
