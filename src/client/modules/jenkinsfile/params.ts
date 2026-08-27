import type { JenkinsfileParam, JenkinsfileParamType } from "../../../server/types";

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
