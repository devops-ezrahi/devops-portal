import { stepSpec, type ArgKind, type ArgSpec } from "./catalog";
import type { JenkinsfilePipeline, JenkinsfileStage } from "../../../server/types";

export const DEFAULT_LIBRARY = "jenkins-k8s-shared-library";

/**
 * Groovy Maps are edited as ordered key/value pairs, not as a JS object: an
 * object cannot hold the half-typed state of renaming a key (clear it and the
 * row collides with any other blank-keyed row, and the entry vanishes under the
 * cursor). They become objects again at the edges — `recordOf` on the way to the
 * server, and the generator reads either shape.
 */
export type MapPairs = [string, string][];

export function pairsOf(value: unknown): MapPairs {
  if (Array.isArray(value)) return value as MapPairs;
  if (value && typeof value === "object") return Object.entries(value as Record<string, string>);
  return [];
}

export function recordOf(pairs: MapPairs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) if (k.trim()) out[k.trim()] = v;
  return out;
}

/**
 * The pipeline as the builder holds it. Identical to the stored record except
 * that `envVars` is pairs while it is being edited.
 */
export type DraftPipeline = Omit<JenkinsfilePipeline, "envVars"> & { envVars: MapPairs };

export function toDraft(pipeline: JenkinsfilePipeline): DraftPipeline {
  return { ...pipeline, envVars: Object.entries(pipeline.envVars ?? {}) };
}

/** What the save endpoints take — the record's own id, owner and timestamps are the server's. */
export function toInput(draft: DraftPipeline) {
  return {
    name: draft.name.trim(),
    library: draft.library.trim(),
    envVars: recordOf(draft.envVars),
    stages: draft.stages,
  };
}

/** Local-only ids — the server stores whatever the builder sends and never mints these. */
function stageId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createStage(step: string): JenkinsfileStage {
  return { id: stageId(), step, args: {} };
}

/** A pipeline that has never been saved. `id: ""` is what marks it unsaved. */
export function newPipeline(): DraftPipeline {
  return {
    id: "",
    name: "",
    library: DEFAULT_LIBRARY,
    envVars: [],
    stages: [],
    createdBy: "",
    createdByName: "",
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * Move `from` so it lands at index `to` in the resulting array. Out-of-range
 * indices clamp rather than throw — the drop target is computed from pointer
 * geometry, so "past the last card" is a normal thing to ask for.
 */
export function moveStage(stages: JenkinsfileStage[], from: number, to: number): JenkinsfileStage[] {
  if (from < 0 || from >= stages.length) return stages;
  const target = Math.max(0, Math.min(to, stages.length - 1));
  if (target === from) return stages;
  const next = [...stages];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** The value a freshly-added argument starts at, per kind. */
export function emptyValue(kind: ArgKind): unknown {
  switch (kind) {
    case "boolean":
      return true; // you only add a flag in order to turn it on
    case "integer":
      return "";
    case "stringList":
      return [];
    case "stringMap":
      return [] as MapPairs;
    case "objectList":
      return [];
    default:
      return "";
  }
}

/**
 * Whether an argument would contribute nothing to the generated Groovy. The
 * library does the same thing on its side (`args.findAll { it.value != null }`),
 * so a half-filled field is dropped rather than emitted as `title: ''`.
 * Booleans are never empty — `skipStage: false` is a legitimate thing to write.
 */
export function isEmptyArg(kind: ArgKind, value: unknown): boolean {
  switch (kind) {
    case "boolean":
      return typeof value !== "boolean";
    case "integer":
      return value === "" || value === null || value === undefined || Number.isNaN(Number(value));
    case "stringList":
      return !Array.isArray(value) || value.every((v) => String(v ?? "").trim() === "");
    case "stringMap":
      return pairsOf(value).every(([k, v]) => !k.trim() || !String(v ?? "").trim());
    case "objectList":
      return (
        !Array.isArray(value) ||
        value.every((entry) =>
          Object.values((entry ?? {}) as Record<string, string>).every((v) => String(v ?? "").trim() === "")
        )
      );
    default:
      return String(value ?? "").trim() === "";
  }
}

function isSet(spec: ArgSpec | undefined, args: Record<string, unknown>): boolean {
  if (!spec) return false;
  return spec.name in args && !isEmptyArg(spec.kind, args[spec.name]);
}

export type PipelineErrors = {
  /** Keyed by stage id. */
  stages: Record<string, string[]>;
  /** Problems with the pipeline itself rather than one stage. */
  pipeline: string[];
};

/**
 * The same checks `Args/ArgsValidator.validateStageArgs` makes in the library,
 * run here so a mistake shows up while you type instead of three minutes into a
 * build. Defaults the step fills in itself count as set — `sonarStage` needs no
 * `image` because it assigns one before validating.
 */
export function validatePipeline(pipeline: DraftPipeline): PipelineErrors {
  const errors: PipelineErrors = { stages: {}, pipeline: [] };

  if (!pipeline.library.trim()) errors.pipeline.push("The @Library name cannot be empty.");
  if (pipeline.stages.length === 0) errors.pipeline.push("A pipeline needs at least one stage.");
  for (const [key, value] of pipeline.envVars) {
    if (key.trim() && !String(value ?? "").trim()) errors.pipeline.push(`Environment variable ${key} has no value.`);
  }

  for (const stage of pipeline.stages) {
    const spec = stepSpec(stage.step);
    const found: string[] = [];
    if (!spec) {
      errors.stages[stage.id] = [`Unknown step ${stage.step} — it is not in the shared library.`];
      continue;
    }
    const find = (name: string) => spec.args.find((a) => a.name === name);

    if (!isSet(find("title"), stage.args) && !spec.defaults?.title) {
      found.push("title is required.");
    }

    // genStageWindows overwrites node with "windows" before validating, so the
    // image/node choice is already made for it.
    if (stage.step !== "genStageWindows") {
      const hasImage = isSet(find("image"), stage.args) || Boolean(spec.defaults?.image);
      const hasNode = isSet(find("node"), stage.args);
      if (hasImage && hasNode) {
        found.push(
          spec.defaults?.image && !isSet(find("image"), stage.args)
            ? `Remove node — this step already runs on image ${spec.defaults.image}.`
            : "Set image or node, not both."
        );
      } else if (!hasImage && !hasNode) {
        found.push("Set exactly one of image or node.");
      }
    }

    // The library's secretsValidator / additionalReposValidator / customPVCValidator
    // all reject an entry missing one of their required keys.
    for (const arg of spec.args) {
      if (arg.kind !== "objectList" || !(arg.name in stage.args)) continue;
      const entries = (stage.args[arg.name] as Record<string, string>[]) ?? [];
      entries.forEach((entry, i) => {
        if (Object.values(entry ?? {}).every((v) => String(v ?? "").trim() === "")) return;
        for (const field of arg.fields ?? []) {
          if (field.required && !String(entry?.[field.name] ?? "").trim()) {
            found.push(`${arg.name} #${i + 1} needs ${field.name}.`);
          }
        }
      });
    }

    if (found.length) errors.stages[stage.id] = found;
  }

  return errors;
}

export function hasErrors(errors: PipelineErrors): boolean {
  return errors.pipeline.length > 0 || Object.keys(errors.stages).length > 0;
}

/** The label a stage card shows: the title if there is one, else the step's default. */
export function stageLabel(stage: JenkinsfileStage): string {
  const title = String(stage.args.title ?? "").trim();
  if (title) return title;
  return stepSpec(stage.step)?.defaults?.title ?? stepSpec(stage.step)?.label ?? stage.step;
}
