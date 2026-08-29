import { stepSpec, type ArgKind, type ArgSpec } from "./catalog";
import { newParam } from "./params";
import type { JenkinsfileParam, JenkinsfilePipeline, JenkinsfileStage } from "../../../server/types";

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

/**
 * A `commands` argument is either a list of shell lines or a Groovy closure —
 * the library's `executeCommands` branches on exactly that. The closure form is
 * boxed rather than stored as a bare string so the two are never confused: an
 * array is shell, `{ closure }` is Groovy.
 */
export type CommandsValue = string[] | { closure: string };

/** The closure body if this value is one, else null. */
export function closureOf(value: unknown): string | null {
  if (value && typeof value === "object" && !Array.isArray(value) && "closure" in value) {
    return String((value as { closure: unknown }).closure ?? "");
  }
  return null;
}

/** The non-blank lines of a list-shaped value. */
export function linesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

export function recordOf(pairs: MapPairs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) if (k.trim()) out[k.trim()] = v;
  return out;
}

/**
 * The pipeline as the builder holds it. Identical to the stored record except
 * that the legacy pipeline-level `envVars` map is gone — it lives in a
 * `populateEnvVars` stage now, like every other top-level call.
 */
export type DraftPipeline = Omit<JenkinsfilePipeline, "envVars" | "params"> & { params: JenkinsfileParam[] };

/**
 * Every parameter was a `booleanParam` before the other types existed, and its
 * default was a real boolean. Normalise both on the way in, so the editor only
 * ever deals with one shape.
 */
function toParam(stored: JenkinsfileParam): JenkinsfileParam {
  return {
    ...newParam(),
    ...stored,
    type: stored.type ?? "boolean",
    defaultValue: String(stored.defaultValue ?? ""),
  };
}

export function toDraft(pipeline: JenkinsfilePipeline): DraftPipeline {
  const { envVars, ...rest } = pipeline;
  const legacy = Object.entries(envVars ?? {});
  return {
    ...rest,
    params: (pipeline.params ?? []).map(toParam),
    // A record written before populateEnvVars became a card carries its map at
    // the top level. Migrate it into the leading stage on open; the save below
    // then writes `{}` back and the record is in the new shape for good.
    stages: legacy.length
      ? // Folded like the rest of a saved pipeline: it is not new work, it is the
        // same map it always had, now shown where it belongs.
        [{ ...createStage("populateEnvVars"), args: { envVars: legacy }, collapsed: true }, ...pipeline.stages]
      : pipeline.stages,
  };
}

/**
 * What the save endpoints take. The record's own id, owner and timestamps stay
 * the server's. `name` is sent because the topbar can change it — blank means
 * "keep it", and on create the server mints one from the author.
 */
export function toInput(draft: DraftPipeline) {
  return {
    name: draft.name.trim(),
    library: draft.library.trim(),
    // Always empty: the map moved into a stage, and PUT merges over the stored
    // record, so sending nothing would leave a migrated pipeline's old copy behind.
    envVars: {},
    params: draft.params.filter((p) => p.name.trim()).map((p) => ({ ...p, name: p.name.trim() })),
    stages: draft.stages,
  };
}

/** Local-only ids — the server stores whatever the builder sends and never mints these. */
function stageId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createStage(step: string): JenkinsfileStage {
  // Collapsed: adding a stage is a decision about the list, not an invitation to
  // fill it in — a card that unfolds pushes everything under it down the page.
  return { id: stageId(), step, args: {}, collapsed: true };
}

/** A pipeline that has never been saved. `id: ""` is what marks it unsaved. */
export function newPipeline(): DraftPipeline {
  return {
    id: "",
    name: "",
    // Empty: the @Library line is opt-in, added by the dotted button.
    library: "",
    params: [],
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
    case "expression":
      return "";
    case "commands":
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
    case "expression":
      // Records written before the skip condition became an expression hold a
      // real boolean here; `false` is still "not set" for those.
      return typeof value === "boolean" ? !value : String(value ?? "").trim() === "";
    case "commands": {
      const closure = closureOf(value);
      return closure === null ? linesOf(value).length === 0 : closure.trim() === "";
    }
    case "stringList":
      return linesOf(value).length === 0;
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

/** The shape of "nothing wrong", for the stretch before the first save attempt. */
export const NO_ERRORS: PipelineErrors = Object.freeze({ stages: {}, pipeline: [] });

/**
 * The same checks `Args/ArgsValidator.validateStageArgs` makes in the library,
 * run here so a mistake shows up while you type instead of three minutes into a
 * build. Defaults the step fills in itself count as set — `sonarStage` needs no
 * `image` because it assigns one before validating.
 */
export function validatePipeline(pipeline: DraftPipeline): PipelineErrors {
  const errors: PipelineErrors = { stages: {}, pipeline: [] };

  if (pipeline.stages.length === 0) errors.pipeline.push("A pipeline needs at least one stage.");

  // Jenkins takes the parameter name as a Groovy identifier — `params.my-flag`
  // does not parse — and a duplicate silently wins over the one before it.
  const seen = new Set<string>();
  for (const param of pipeline.params) {
    const name = param.name.trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.pipeline.push(`Parameter ${name} is not a valid Groovy identifier.`);
    }
    if (seen.has(name)) errors.pipeline.push(`Parameter ${name} is declared twice.`);
    seen.add(name);
  }

  for (const stage of pipeline.stages) {
    const spec = stepSpec(stage.step);
    const found: string[] = [];
    if (!spec) {
      errors.stages[stage.id] = [`Unknown step ${stage.step} — it is not in the shared library.`];
      continue;
    }
    const find = (name: string) => spec.args.find((a) => a.name === name);

    // Only steps that actually offer the choice are held to it: genStageWindows
    // forces node = 'windows' itself, and populateEnvVars runs on neither.
    if (find("image") || find("node")) {
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

    // Covers `title` too: it carries `required` on exactly the two steps that do
    // not name one themselves, which is the same rule the library applies.
    for (const arg of spec.args) {
      if (arg.required && !isSet(arg, stage.args)) found.push(`${arg.name} is required.`);
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
