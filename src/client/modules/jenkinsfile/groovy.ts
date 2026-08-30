import { stepSpec, type ArgKind, type ArgSpec } from "./catalog";
import { closureOf, isEmptyArg, linesOf, pairsOf, type DraftPipeline } from "./pipeline";
import { PARAM_TYPES } from "./params";
import type { JenkinsfileParam, JenkinsfileStage } from "../../../server/types";

const INDENT = "    ";

/**
 * A string containing `${` has to stay a GString or the interpolation is lost —
 * `title: "Build ${env.SERVICE}"` is exactly what the library's own steps write.
 * Everything else gets single quotes, which need no escaping of `$`.
 */
function quote(raw: string): string {
  const value = String(raw);
  if (value.includes("${")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A list pasted out of an existing Jenkinsfile arrives already quoted and
 * comma-separated — `"npm install",` on its own line. Taking that literally
 * would emit `'"npm install",'` and run a command that does not exist, so the
 * wrapper comes off and the generator puts its own quoting back.
 *
 * Only a line that is quoted end to end with nothing of that quote inside it
 * counts, so `echo "hi"` and `"$A" = "$B"` are left exactly as typed.
 */
function unwrap(line: string): string {
  let text = line.trim().replace(/,$/, "").trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) {
    const inner = text.slice(1, -1);
    if (!inner.includes(quote)) text = inner;
  }
  return text.trim();
}

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : quote(name);
}

/**
 * `[a, b, c]` on one line, or one entry per line once that would run long.
 * An entry that already broke across lines never gets inlined — otherwise a
 * single multi-line secret renders as `[[` with its closing bracket stranded.
 * `stacked` forces a line per entry however short they are: commands are read
 * as a script, one per row, the way they were typed.
 */
function bracket(entries: string[], indent: string, stacked = false): string {
  if (entries.length === 0) return "[]";
  const inline = `[${entries.join(", ")}]`;
  if (!stacked && !inline.includes("\n") && inline.length + indent.length <= 100) return inline;
  return `[\n${entries.map((e) => `${indent}${INDENT}${e}`).join(",\n")}\n${indent}]`;
}

function mapEntries(value: unknown): string[] {
  return pairsOf(value)
    .filter(([k, v]) => k.trim() && String(v ?? "").trim())
    .map(([k, v]) => `${key(k.trim())}: ${quote(String(v).trim())}`);
}

function renderValue(kind: ArgKind, value: unknown, indent: string): string {
  switch (kind) {
    case "expression":
      // Emitted raw — the point of the field is to write `params.skipImage`, not
      // the string "params.skipImage". Older records hold a real boolean here.
      return typeof value === "boolean" ? String(value) : String(value).trim();
    case "boolean":
      return value ? "true" : "false";
    case "integer":
      return String(Number(value));
    case "commands": {
      // The library's executeCommands takes either: an ArrayList it joins with
      // `&&` and hands to sh, or a Closure it simply calls. A closure is written
      // through verbatim — it is Groovy the user typed, not a value to quote.
      const closure = closureOf(value);
      if (closure !== null) {
        // Blank lines inside the body are the author's; blank lines around it
        // are just where the cursor stopped.
        const body = closure.split("\n").map((line) => line.trimEnd());
        while (body.length && !body[0].trim()) body.shift();
        while (body.length && !body[body.length - 1].trim()) body.pop();
        return `{\n${body.map((line) => (line.trim() ? `${indent}${INDENT}${line}` : "")).join("\n")}\n${indent}}`;
      }
      return bracket(linesOf(value).map(unwrap).filter(Boolean).map(quote), indent, true);
    }
    case "stringList":
      return bracket(linesOf(value).map(unwrap).filter(Boolean).map(quote), indent);
    case "stringMap":
      return bracket(mapEntries(value), indent);
    case "objectList":
      return bracket(
        (value as Record<string, unknown>[])
          .filter((entry) => Object.values(entry ?? {}).some((v) => String(v ?? "").trim()))
          .map((entry) => bracket(mapEntries(entry ?? {}), `${indent}${INDENT}`)),
        indent
      );
    default:
      return quote(String(value).trim());
  }
}

/** Catalog order, not insertion order — so the same pipeline always prints the same way. */
function setArgs(stage: JenkinsfileStage): { spec: ArgSpec; value: unknown }[] {
  const spec = stepSpec(stage.step);
  if (!spec) return [];
  return spec.args
    .filter((arg) => arg.name in stage.args && !isEmptyArg(arg.kind, stage.args[arg.name]))
    .map((arg) => ({ spec: arg, value: stage.args[arg.name] }));
}

export function stageToGroovy(stage: JenkinsfileStage): string {
  const args = setArgs(stage);
  if (args.length === 0) return `${stage.step}()`;

  // `bare` steps take their one argument as the whole call, with no key in
  // front of it: populateEnvVars([SERVICE: 'x']).
  if (stepSpec(stage.step)?.callStyle === "bare") {
    return `${stage.step}(${renderValue(args[0].spec.kind, args[0].value, "")})`;
  }

  const inlineParts = args.map(({ spec, value }) => `${spec.name}: ${renderValue(spec.kind, value, INDENT)}`);
  const inline = `${stage.step}(${inlineParts.join(", ")})`;
  if (args.length === 1 && !inline.includes("\n") && inline.length <= 100) return inline;

  const lines = args.map(({ spec, value }) => `${INDENT}${spec.name}: ${renderValue(spec.kind, value, INDENT)}`);
  return `${stage.step}(\n${lines.join(",\n")}\n)`;
}

/**
 * One entry of the `parameters([...])` block. A `choice` takes its options
 * instead of a default — Jenkins uses the first one — so it is the one shape
 * that differs.
 */
export function paramToGroovy(param: JenkinsfileParam): string {
  const spec = PARAM_TYPES.find((t) => t.type === param.type) ?? PARAM_TYPES[0];
  const name = `name: ${quote(param.name.trim())}`;
  const description = `description: ${quote(param.description.trim())}`;

  if (param.type === "choice") {
    const choices = (param.choices ?? []).map((c) => c.trim()).filter(Boolean);
    return `${spec.fn}(${name}, choices: ${bracket(choices.map(quote), `${INDENT}${INDENT}`)}, ${description})`;
  }

  const value = param.type === "boolean" ? String(param.defaultValue === "true") : quote(param.defaultValue);
  return `${spec.fn}(${name}, defaultValue: ${value}, ${description})`;
}

/**
 * The whole Jenkinsfile. Scripted, not declarative: every step in the library
 * opens its own `stage()` (through podLauncher / nodeExecutor), so they are
 * called one after another at the top level rather than inside a `pipeline {}`
 * block.
 */
export function toGroovy(pipeline: DraftPipeline): string {
  // The import is optional: a pipeline that calls no library step needs no line.
  const blocks: string[] = [];
  if (pipeline.library.trim()) blocks.push(`@Library('${pipeline.library.trim()}') _`);

  const params = pipeline.params.filter((p) => p.name.trim());
  if (params.length) {
    const declared = params.map((p) => `${INDENT}${INDENT}${paramToGroovy(p)}`);
    blocks.push(`properties([\n${INDENT}parameters([\n${declared.join(",\n")}\n${INDENT}])\n])`);
  }

  for (const stage of pipeline.stages) blocks.push(stageToGroovy(stage));

  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}
