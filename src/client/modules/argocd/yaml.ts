/**
 * The YAML writer, ported from universal-chart's own `ui/studio.html`
 * (its `scalar` / `blockLines` / `clean` / `emitNode` / `toYaml`).
 *
 * Reading YAML is the `yaml` package's job — a hand-rolled parser is the kind
 * of "85% correct" thing that fails silently on a real file, and these are
 * values people are about to deploy. Writing stays hand-rolled because the
 * emitted shape is the point: stable key order, block scalars for multi-line
 * strings, and `{}` / `[]` for the empty ones the chart's own defaults use.
 */

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
  // A bare `true`, `1.5` or `no` would come back typed; quoting keeps it a string.
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return JSON.stringify(s);
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return JSON.stringify(s);
  if (/^[#&*!|>%@`'"[\]{},?-]/.test(s)) return JSON.stringify(s);
  if (/:\s|\s#|\*/.test(s)) return JSON.stringify(s);
  return s;
}

function blockLines(v: unknown, ind: number): string[] {
  // `|` keeps a trailing newline, `|-` strips it — which one is which matters
  // for a ConfigMap whose consumer cares.
  const out = [String(v).endsWith("\n") ? "|" : "|-"];
  const pad = " ".repeat(ind + 2);
  String(v)
    .replace(/\s+$/, "")
    .split("\n")
    .forEach((l) => out.push(l ? pad + l : ""));
  return out;
}

export function emitNode(node: unknown, ind: number, out: string[]): string[] {
  const pad = " ".repeat(ind);
  if (Array.isArray(node)) {
    node.forEach((it) => {
      if (it && typeof it === "object" && !isRaw(it) && !isFlow(it) && !Array.isArray(it)) {
        const c = clean(it as Record<string, unknown>);
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
    if (v === undefined || v === null) continue;
    if (isRaw(v)) {
      out.push(pad + k + ":");
      String(v.__raw)
        .split("\n")
        .forEach((l) => out.push(l ? " ".repeat(ind + 2) + l : ""));
    } else if (isFlow(v)) {
      out.push(pad + k + ": [" + v.__flow.map(scalar).join(", ") + "]");
    } else if (Array.isArray(v)) {
      if (!v.length) {
        out.push(pad + k + ": []");
        continue;
      }
      out.push(pad + k + ":");
      emitNode(v, ind + 2, out);
    } else if (typeof v === "object") {
      const c = clean(v as Record<string, unknown>);
      if (!Object.keys(c).length) {
        out.push(pad + k + ": {}");
        continue;
      }
      out.push(pad + k + ":");
      emitNode(c, ind + 2, out);
    } else if (typeof v === "string" && v.includes("\n")) {
      const b = blockLines(v, ind);
      out.push(pad + k + ": " + b[0]);
      b.slice(1).forEach((l) => out.push(l));
    } else out.push(pad + k + ": " + scalar(v));
  }
  return out;
}

export function toYaml(doc: Record<string, unknown>): string {
  return emitNode(clean(doc), 0, []).join("\n");
}
