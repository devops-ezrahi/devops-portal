import { Plus, X } from "lucide-react";
import { PARAM_TYPES, newParam, type ParamTypeSpec } from "../params";
import type { JenkinsfileParam, JenkinsfileParamType } from "../../../../server/types";

type Props = {
  params: JenkinsfileParam[];
  /** Names the stages actually read — see `usedParamNames`. */
  used: Set<string>;
  /** The leave-scopes touched so far — see `useLeaveScopes` in the view. */
  touched: Set<string>;
  onLeave: (scope: string) => void;
  onChange: (params: JenkinsfileParam[]) => void;
};

/**
 * One touch scope per parameter, exactly as a stage card uses its own id: a
 * parameter you have just added is not a mistake while you are still typing its
 * name, and the section as a whole was left long ago on an open pipeline.
 *
 * Keyed on the **name**, not the position. A parameter carries no id, and the
 * index is not one: remove a parameter and add another and the new one lands on
 * an index that was already left, so it went amber on its first keystroke — the
 * bug this replaced. A name that is still being typed is a scope nobody has
 * left, which is exactly the wanted answer; editing an existing name quietens
 * it again until the next press outside, which is also right, since a renamed
 * parameter is being worked on.
 */
export const paramScope = (param: JenkinsfileParam) => `param:${param.name.trim()}`;

/**
 * The pipeline's build parameters — what Jenkins puts on the Build with
 * Parameters screen. They are what makes a skip condition a build-time choice
 * rather than a code edit: declare `skipImage` here, then point a stage's skip
 * condition at `params.skipImage`.
 *
 * Each one is laid out like a stage argument — labelled fields, a type badge, a
 * hint underneath — because that is what every other editable thing on this
 * page looks like.
 *
 * Every type stores its default as a string, so switching a parameter's type
 * keeps whatever was already typed into it instead of blanking the row.
 */
export function ParamsEditor({ params, used, touched, onLeave, onChange }: Props) {
  function set(i: number, patch: Partial<JenkinsfileParam>) {
    onChange(params.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  }

  // Most pipelines declare none, so off is the resting state: the same dotted
  // button the shared-library import uses, in the shape of what it opens into.
  if (params.length === 0) {
    return (
      <button type="button" className="jf-dotted" onClick={() => onChange([newParam()])}>
        <Plus size={15} aria-hidden="true" />
        <span>
          <strong>Add pipeline parameters</strong>
          <small>
            Shown on Jenkins&rsquo; Build with Parameters screen. Optional — a boolean <code>skipImage</code>,
            say, read from a stage&rsquo;s skip condition as <code>params.skipImage</code>.
          </small>
        </span>
      </button>
    );
  }

  return (
    <div className="jf-params">
      <div className="jf-list-head">
        <h2>Pipeline parameters</h2>
        <span className="jf-group-count">
          {params.length} param{params.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="jf-arg-list jf-param-list">
          {params.map((param, i) => {
            const spec = PARAM_TYPES.find((t) => t.type === param.type) ?? PARAM_TYPES[0];
            const id = `jf-param-${i}`;
            // Not an error — the Jenkinsfile is valid, the parameter just does
            // nothing yet — so it is a colour and a line, not a red problem.
            const unused =
              touched.has(paramScope(param)) && Boolean(param.name.trim()) && !used.has(param.name.trim());
            return (
              <div
                className={`jf-arg jf-param${unused ? " jf-param-unused" : ""}`}
                key={i}
                data-touch-scope={paramScope(param)}
                // Tabbing out counts as leaving too; a null relatedTarget is a
                // press on something unfocusable, which the document listener
                // places properly. Same rule as StageCard.
                onBlur={(e) => {
                  if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) onLeave(paramScope(param));
                }}
              >
                <div className="jf-arg-head">
                  <label htmlFor={`${id}-name`}>{param.name.trim() || `parameter ${i + 1}`}</label>
                  <span className="jf-kind">{spec.label}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove parameter ${i + 1}`}
                    title={`Remove parameter ${i + 1}`}
                    onClick={() => onChange(params.filter((_, n) => n !== i))}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>

                <div className="jf-param-grid">
                  <div className="form-field">
                    <label htmlFor={`${id}-name`}>name</label>
                    <input
                      id={`${id}-name`}
                      type="text"
                      spellCheck={false}
                      placeholder="skipImage"
                      aria-label={`Parameter ${i + 1} name`}
                      value={param.name}
                      onChange={(e) => set(i, { name: e.target.value })}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={`${id}-type`}>type</label>
                    <select
                      id={`${id}-type`}
                      aria-label={`Parameter ${i + 1} type`}
                      value={param.type}
                      onChange={(e) => set(i, retype(param, e.target.value as JenkinsfileParamType))}
                    >
                      {PARAM_TYPES.map((t) => (
                        <option key={t.type} value={t.type}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label htmlFor={`${id}-description`}>description</label>
                    <input
                      id={`${id}-description`}
                      type="text"
                      placeholder="shown beside it in Jenkins"
                      aria-label={`Parameter ${i + 1} description`}
                      value={param.description}
                      onChange={(e) => set(i, { description: e.target.value })}
                    />
                  </div>
                </div>

                <ParamValue id={id} index={i} param={param} spec={spec} onSet={(patch) => set(i, patch)} />
                <span className="field-hint">
                  {unused ? (
                    <>
                      No stage reads <code>params.{param.name.trim()}</code> — declaring it changes nothing.
                    </>
                  ) : (
                    spec.hint
                  )}
                </span>
              </div>
            );
        })}
        {/* Inside the list and after the entries, exactly like the Add entry
            under a `commands` or `secrets` list — a parameter is one more row of
            the same list, not a section-level action. */}
        <button
          type="button"
          className="ghost-button jf-add-row"
          onClick={() => onChange([...params, newParam()])}
        >
          <Plus size={15} aria-hidden="true" /> Add parameter
        </button>
      </div>
    </div>
  );
}

/**
 * Changing the type keeps the default where the two types agree on what one
 * means, and drops it where they do not — `"true"` is not a sensible default
 * string, and a free-typed string is not one of the choices.
 */
function retype(param: JenkinsfileParam, type: JenkinsfileParamType): Partial<JenkinsfileParam> {
  const wasFlag = param.type === "boolean";
  const isFlag = type === "boolean";
  return {
    type,
    defaultValue: wasFlag === isFlag ? param.defaultValue : isFlag ? "false" : "",
    choices: type === "choice" ? param.choices ?? [""] : undefined,
  };
}

function ParamValue({
  id,
  index,
  param,
  spec,
  onSet,
}: {
  id: string;
  index: number;
  param: JenkinsfileParam;
  spec: ParamTypeSpec;
  onSet: (patch: Partial<JenkinsfileParam>) => void;
}) {
  if (param.type === "boolean") {
    return (
      <div className="form-field">
        <label htmlFor={`${id}-value`}>default</label>
        <label className="jf-checkbox" htmlFor={`${id}-value`}>
          <input
            id={`${id}-value`}
            type="checkbox"
            aria-label={`Parameter ${index + 1} default value`}
            checked={param.defaultValue === "true"}
            onChange={(e) => onSet({ defaultValue: String(e.target.checked) })}
          />
          {param.defaultValue === "true" ? "true" : "false"}
        </label>
      </div>
    );
  }

  if (param.type === "choice") {
    // Jenkins takes the first choice as the default, so there is no separate
    // default field — the order is the answer.
    const choices = param.choices?.length ? param.choices : [""];
    return (
      <div className="form-field">
        <label htmlFor={`${id}-value`}>choices — the first one is the default</label>
        {/* Grows with the list rather than capping and scrolling: the whole
            point of the field is seeing the options in order, and the first one
            is the default. */}
        <textarea
          id={`${id}-value`}
          className="jf-lines"
          aria-label={`Parameter ${index + 1} choices`}
          // At least as many rows as the placeholder has lines, or the last
          // suggestion is cut off before anything has been typed.
          rows={Math.max(3, choices.length + 1)}
          placeholder={"dev\nstaging\nprod"}
          value={choices.join("\n")}
          onChange={(e) => onSet({ choices: e.target.value.split("\n") })}
        />
      </div>
    );
  }

  return (
    <div className="form-field">
      <label htmlFor={`${id}-value`}>default</label>
      <input
        id={`${id}-value`}
        type="text"
        aria-label={`Parameter ${index + 1} default value`}
        placeholder={spec.placeholder}
        value={param.defaultValue}
        onChange={(e) => onSet({ defaultValue: e.target.value })}
      />
    </div>
  );
}
