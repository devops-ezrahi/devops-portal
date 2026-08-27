import { stepSpec, type ArgKind, type ArgSpec } from "./catalog";
import { isEmptyArg, pairsOf, type DraftPipeline } from "./pipeline";
import type { JenkinsfileStage } from "../../../server/types";

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

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : quote(name);
}

/**
 * `[a, b, c]` on one line, or one entry per line once that would run long.
 * An entry that already broke across lines never gets inlined — otherwise a
 * single multi-line secret renders as `[[` with its closing bracket stranded.
 */
function bracket(entries: string[], indent: string): string {
  if (entries.length === 0) return "[]";
  const inline = `[${entries.join(", ")}]`;
  if (!inline.includes("\n") && inline.length + indent.length <= 100) return inline;
  return `[\n${entries.map((e) => `${indent}${INDENT}${e}`).join(",\n")}\n${indent}]`;
}

function mapEntries(value: unknown): string[] {
  return pairsOf(value)
    .filter(([k, v]) => k.trim() && String(v ?? "").trim())
    .map(([k, v]) => `${key(k.trim())}: ${quote(String(v).trim())}`);
}

function renderValue(kind: ArgKind, value: unknown, indent: string): string {
  switch (kind) {
    case "boolean":
      return value ? "true" : "false";
    case "integer":
      return String(Number(value));
    case "stringList":
      return bracket(
        (value as string[]).map((v) => String(v ?? "").trim()).filter(Boolean).map(quote),
        indent
      );
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

  const inlineParts = args.map(({ spec, value }) => `${spec.name}: ${renderValue(spec.kind, value, INDENT)}`);
  const inline = `${stage.step}(${inlineParts.join(", ")})`;
  if (args.length === 1 && !inline.includes("\n") && inline.length <= 100) return inline;

  const lines = args.map(({ spec, value }) => `${INDENT}${spec.name}: ${renderValue(spec.kind, value, INDENT)}`);
  return `${stage.step}(\n${lines.join(",\n")}\n)`;
}

/**
 * The whole Jenkinsfile. Scripted, not declarative: every step in the library
 * opens its own `stage()` (through podLauncher / nodeExecutor), so they are
 * called one after another at the top level rather than inside a `pipeline {}`
 * block.
 */
export function toGroovy(pipeline: DraftPipeline): string {
  const blocks: string[] = [`@Library('${pipeline.library.trim() || "jenkins-k8s-shared-library"}') _`];

  const envVars = mapEntries(pipeline.envVars);
  if (envVars.length) {
    blocks.push(`populateEnvVars([\n${envVars.map((e) => `${INDENT}${e}`).join(",\n")}\n])`);
  }

  for (const stage of pipeline.stages) blocks.push(stageToGroovy(stage));

  return `${blocks.join("\n\n")}\n`;
}
