/**
 * The YAML writer, ported from universal-chart's own `ui/studio.html`
 * (its `scalar` / `blockLines` / `clean` / `emitNode` / `toYaml`).
 *
 * Reading YAML is the `yaml` package's job — a hand-rolled parser is the kind
 * of "85% correct" thing that fails silently on a real file, and these are
 * values people are about to deploy. Writing stays hand-rolled because the
 * emitted shape is the point: stable key order, block scalars for multi-line
 * strings, and `{}` / `[]` for the empty ones the chart's own defaults use.
 *
 * Both directions follow **Helm's** reader, not the YAML spec's latest word:
 * `helm template` reads values files the way go-yaml v2 does (checked by
 * dumping `.Values`), so `yes`/`y`/`off` are booleans, `0644` is octal, `08` is
 * the number 8 and `.inf` cannot be rendered at all. A writer that leaves one of
 * those bare turns a string into something else, and a reader that types them
 * the YAML 1.2 way disagrees with what Argo CD will deploy.
 */

import { parseAllDocuments, visit } from "yaml";

/**
 * A plain (unquoted) scalar the way go-yaml v2 types it. Throws for `.inf` /
 * `.nan`, which Helm cannot render (JSON has no such number).
 */
export function goYamlPlain(src: string): unknown {
  if (/^(~|null|Null|NULL|)$/.test(src)) return null;
  if (/^(y|Y|yes|Yes|YES|on|On|ON|true|True|TRUE)$/.test(src)) return true;
  if (/^(n|N|no|No|NO|off|Off|OFF|false|False|FALSE)$/.test(src)) return false;
  if (/^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(src)) throw new Error(`${src} is not a value Helm can render`);
  const sign = src.startsWith("-") ? -1 : 1;
  const digits = src.replace(/^[-+]/, "").replace(/_/g, "");
  const int = (re: RegExp, radix: number, skip: number) => (re.test(digits) ? sign * parseInt(digits.slice(skip), radix) : undefined);
  const asInt =
    int(/^0[xX][0-9a-fA-F]+$/, 16, 2) ??
    int(/^0[oO][0-7]+$/, 8, 2) ??
    int(/^0[bB][01]+$/, 2, 2) ??
    int(/^0[0-7]+$/, 8, 1) ??
    int(/^(0|[1-9][0-9]*)$/, 10, 0);
  if (asInt !== undefined) return asInt;
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(src)) return parseFloat(src);
  return src;
}

/** Whether `s`, written bare, would come back as anything but this same string. */
export function retypes(s: string): boolean {
  try {
    return goYamlPlain(s) !== s;
  } catch {
    return true;
  }
}

/**
 * One values file as Helm reads it: the first document only, a byte-order
 * mark ignored, a repeated key's last value kept, `<<` merge keys applied and
 * every plain scalar typed by `goYamlPlain`. `doc` is null for an empty file;
 * `error` says why Helm could not read it at all.
 */
export function parseHelm(text: string): { doc: unknown; error?: string } {
  const docs = parseAllDocuments(text.replace(/^\uFEFF/, ""), { version: "1.1", uniqueKeys: false, merge: true });
  const first = Array.isArray(docs) ? docs[0] : docs;
  if (!first) return { doc: null };
  if (first.errors.length) return { doc: null, error: first.errors[0].message.split("\n")[0] };
  try {
    visit(first, {
      Scalar(key, node) {
        if (key !== "key" && node.type === "PLAIN" && typeof node.source === "string") node.value = goYamlPlain(node.source);
      },
    });
  } catch (err) {
    return { doc: null, error: (err as Error).message };
  }
  try {
    return { doc: first.toJS({ maxAliasCount: -1 }) ?? null };
  } catch (err) {
    // An alias whose anchor is gone, say — Helm refuses the file too.
    return { doc: null, error: (err as Error).message.split("\n")[0] };
  }
}

/** A flow-style sequence: `key: [a, b, c]`. */
export type FlowSeq = { __flow: unknown[] };
/** A block of YAML written through verbatim — the escape hatch. */
export type RawBlock = { __raw: string };

export const flow = (items: unknown[]): FlowSeq => ({ __flow: items });
export const raw = (text: unknown): RawBlock => ({ __raw: String(text).replace(/\s+$/, "") });

const isFlow = (v: unknown): v is FlowSeq => !!v && typeof v === "object" && "__flow" in v;
const isRaw = (v: unknown): v is RawBlock => !!v && typeof v === "object" && "__raw" in v;

/** Drop the empties: an unset field must not reach the file as `key: ""`. */
export function clean(o: Record<string, unknown>): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "object" && !Array.isArray(v) && !isRaw(v) && !isFlow(v) && Object.keys(v as object).length === 0)
      continue;
    if (Array.isArray(v) && !v.length) continue;
    r[k] = v;
  }
  return r;
}

export function scalar(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (s === "") return '""';
  if (/^\s|\s$/.test(s)) return JSON.stringify(s);
  // A bare `true`, `1.5`, `y`, `08` or `0x1F` would come back typed (see
  // goYamlPlain); quoting keeps it a string.
  if (retypes(s)) return JSON.stringify(s);
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return JSON.stringify(s);
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return JSON.stringify(s);
  if (/^[#&*!|>%@`'"[\]{},?-]/.test(s)) return JSON.stringify(s);
  if (/:\s|\s#|\*/.test(s)) return JSON.stringify(s);
  return s;
}

function blockLines(v: unknown, ind: number): string[] {
  const text = String(v);
  const body = text.replace(/\n+$/, "");
  const trailing = text.length - body.length;
  // Chomping: `|-` no trailing newline, `|` exactly one, `|+` all of them —
  // a ConfigMap file's consumer can care which.
  const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
  // A reader takes the indentation from the first non-empty line, so a file
  // that *starts* indented (an XML fragment) needs it stated, or its own
  // leading spaces are read as YAML's and silently dropped.
  const first = body.split("\n").find((l) => l.trim()) ?? "";
  const indicator = /^[ \t]/.test(first) ? "2" : "";
  const out = [`|${indicator}${chomp}`];
  const pad = " ".repeat(ind + 2);
  body.split("\n").forEach((l) => out.push(l ? pad + l : ""));
  // `|+` keeps the extra newlines only as blank lines after the body.
  for (let i = 1; i < trailing && chomp === "+"; i++) out.push("");
  return out;
}

/** A mapping key: bare unless it would be read back as something else (a `y:` key is `true:` to Helm). */
function key(k: string): string {
  return k !== "<<" && (retypes(k) || /^[#&*!|>%@`'"[\]{},?-]|:\s|\s#|^\s|\s$|:$/.test(k)) ? JSON.stringify(k) : k;
}

export function emitNode(node: unknown, ind: number, out: string[]): string[] {
  const pad = " ".repeat(ind);
  if (Array.isArray(node)) {
    node.forEach((it) => {
      if (it && typeof it === "object" && !isRaw(it) && !isFlow(it) && !Array.isArray(it)) {
        const c = it as Record<string, unknown>;
        if (!Object.keys(c).length) {
          out.push(pad + "- {}");
          return;
        }
        const sub: string[] = [];
        emitNode(c, ind + 2, sub);
        sub[0] = pad + "- " + sub[0].slice(ind + 2);
        sub.forEach((l) => out.push(l));
      } else if (typeof it === "string" && it.includes("\n")) {
        const b = blockLines(it, ind);
        out.push(pad + "- " + b[0]);
        b.slice(1).forEach((l) => out.push(l));
      } else out.push(pad + "- " + scalar(it));
    });
    return out;
  }
  for (const k of Object.keys(node as Record<string, unknown>)) {
    const v = (node as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (v === null) {
      out.push(pad + key(k) + ": null");
      continue;
    }
    if (isRaw(v)) {
      out.push(pad + key(k) + ":");
      String(v.__raw)
        .split("\n")
        .forEach((l) => out.push(l ? " ".repeat(ind + 2) + l : ""));
    } else if (isFlow(v)) {
      out.push(pad + key(k) + ": [" + v.__flow.map(scalar).join(", ") + "]");
    } else if (Array.isArray(v)) {
      if (!v.length) {
        out.push(pad + key(k) + ": []");
        continue;
      }
      out.push(pad + key(k) + ":");
      emitNode(v, ind + 2, out);
    } else if (typeof v === "object") {
      const c = v as Record<string, unknown>;
      if (!Object.keys(c).length) {
        out.push(pad + key(k) + ": {}");
        continue;
      }
      out.push(pad + key(k) + ":");
      emitNode(c, ind + 2, out);
    } else if (typeof v === "string" && v.includes("\n")) {
      const b = blockLines(v, ind);
      out.push(pad + key(k) + ": " + b[0]);
      b.slice(1).forEach((l) => out.push(l));
    } else out.push(pad + key(k) + ": " + scalar(v));
  }
  return out;
}

/** `spaced` puts a blank line between top-level keys — how a values file is written, so each section reads as a block. */
export function toYaml(doc: Record<string, unknown>, spaced = false): string {
  // Not `clean`: a document's own `service: null` (Helm's delete) or `args: []`
  // (clear base's list) is a value, and dropping it brought base's back. A
  // form's unset fields are cleaned where they are emitted (`buildValues`).
  const c = Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));
  if (!spaced) return emitNode(c, 0, []).join("\n");
  return Object.keys(c)
    .map((k) => emitNode({ [k]: c[k] }, 0, []).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}
