import { Plus, X } from "lucide-react";
import { PARAM_TYPES, newParam, type ParamTypeSpec } from "../params";
import type { JenkinsfileParam, JenkinsfileParamType } from "../../../../server/types";

type Props = {
  params: JenkinsfileParam[];
  onChange: (params: JenkinsfileParam[]) => void;
};

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
export function ParamsEditor({ params, onChange }: Props) {
  function set(i: number, patch: Partial<JenkinsfileParam>) {
    onChange(params.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  }

  return (
    <div className="jf-params">
      <div className="jf-list-head">
        <h2>Pipeline parameters</h2>
        <span className="jf-group-count">
          {params.length} param{params.length === 1 ? "" : "s"}
        </span>
      </div>

      {params.length === 0 ? (
        <p className="jf-note">
          None. Add one — a boolean <code>skipImage</code>, say — to expose it in Jenkins and read it from a
          stage&rsquo;s skip condition as <code>params.skipImage</code>.
        </p>
      ) : (
        <div className="jf-arg-list jf-param-list">
          {params.map((param, i) => {
            const spec = PARAM_TYPES.find((t) => t.type === param.type) ?? PARAM_TYPES[0];
            const id = `jf-param-${i}`;
            return (
              <div className="jf-arg jf-param" key={i}>
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
                <span className="field-hint">{spec.hint}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="jf-adder jf-adder-right">
        <button type="button" className="primary" onClick={() => onChange([...params, newParam()])}>
          <Plus size={16} aria-hidden="true" /> Add parameter
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
          rows={Math.max(2, choices.length + 1)}
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
