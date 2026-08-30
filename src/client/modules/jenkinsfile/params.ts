import type { JenkinsfileParam, JenkinsfileParamType, JenkinsfileStage } from "../../../server/types";

export type ParamTypeSpec = {
  type: JenkinsfileParamType;
  label: string;
  /** The `parameters([...])` function Jenkins exposes for it. */
  fn: string;
  hint: string;
  placeholder?: string;
};

/**
 * The parameter types the Jenkins job-DSL `parameters([...])` block accepts.
 * `booleanParam` is the odd one out in naming — the rest are named after the
 * type itself — which is why the emitted function is data here rather than
 * derived from the type.
 */
export const PARAM_TYPES: ParamTypeSpec[] = [
  {
    type: "boolean",
    label: "Boolean",
    fn: "booleanParam",
    hint: "A checkbox. Read it as params.<name> — this is what a stage's skip condition wants.",
  },
  {
    type: "string",
    label: "String",
    fn: "string",
    hint: "A single-line text box.",
    placeholder: "default value",
  },
  {
    type: "choice",
    label: "Choice",
    fn: "choice",
    hint: "A drop-down. Jenkins takes the first choice as the default, so the order is the default.",
  },
];

export function newParam(): JenkinsfileParam {
  return { name: "", type: "boolean", defaultValue: "false", description: "" };
}

/**
 * Parameter names actually referenced by the stages — `params.skipImage`,
 * `params['skipImage']`.
 *
 * A parameter nothing reads is a build-time question with no effect, which is
 * silent until someone wonders why ticking the box changed nothing. Scanning
 * the serialised stages rather than the generated Groovy is deliberate: a
 * reference can sit in any argument shape — an expression, a command line, a
 * closure body, a map value — and JSON.stringify reaches all of them for free.
 */
export function usedParamNames(stages: JenkinsfileStage[]): Set<string> {
  const used = new Set<string>();
  // JSON escapes a double quote as \" — hence the optional backslash.
  const re = /params\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*\\?["']([^"'\\]+)\\?["']\s*\])/g;
  for (const m of JSON.stringify(stages).matchAll(re)) used.add(m[1] ?? m[2]);
  return used;
}
