import { AlertTriangle, Trash2 } from "lucide-react";
import { COMMON_ARG_NAMES, stepSpec } from "../catalog";
import { emptyValue } from "../pipeline";
import { ArgField } from "./ArgField";
import type { JenkinsfileStage } from "../../../../server/types";

type Props = {
  stage: JenkinsfileStage;
  errors: string[];
  onChange: (stage: JenkinsfileStage) => void;
  onRemove: () => void;
};

/**
 * Every argument the step accepts is reachable here, but only the ones actually
 * in use are on screen — genStage alone takes sixteen, and rendering all of them
 * empty would bury the two that matter. The picker at the bottom is the "add all
 * of the different variables" half.
 */
export function StageEditor({ stage, errors, onChange, onRemove }: Props) {
  const spec = stepSpec(stage.step);
  if (!spec) {
    return <p className="jf-empty">Unknown step “{stage.step}” — it is not in the shared library.</p>;
  }

  const used = spec.args.filter((arg) => arg.name in stage.args);
  const unused = spec.args.filter((arg) => !(arg.name in stage.args));

  function setArg(name: string, value: unknown) {
    onChange({ ...stage, args: { ...stage.args, [name]: value } });
  }

  function removeArg(name: string) {
    const { [name]: _dropped, ...rest } = stage.args;
    onChange({ ...stage, args: rest });
  }

  return (
    <div className="jf-editor">
      <div className="jf-editor-head">
        <div>
          <h2>{spec.label}</h2>
          <p className="jf-step-name">
            <code>{spec.step}</code> — {spec.description}
          </p>
        </div>
        <button type="button" className="ghost-button" onClick={onRemove}>
          <Trash2 size={16} aria-hidden="true" /> Remove stage
        </button>
      </div>

      {errors.length > 0 && (
        <ul className="jf-errors" aria-label="Stage problems">
          {errors.map((message) => (
            <li key={message}>
              <AlertTriangle size={14} aria-hidden="true" /> {message}
            </li>
          ))}
        </ul>
      )}

      {used.length === 0 && <p className="jf-empty">No arguments set. Add one below.</p>}

      {used.map((arg) => (
        <ArgField
          key={arg.name}
          spec={arg}
          value={stage.args[arg.name]}
          stepDefault={spec.defaults?.[arg.name]}
          idPrefix={`${stage.id}`}
          onChange={(value) => setArg(arg.name, value)}
          onRemove={() => removeArg(arg.name)}
        />
      ))}

      {unused.length > 0 && (
        <div className="form-field jf-add-arg">
          <label htmlFor={`${stage.id}-add-arg`}>Add argument</label>
          <select
            id={`${stage.id}-add-arg`}
            value=""
            onChange={(e) => {
              const arg = spec.args.find((a) => a.name === e.target.value);
              if (arg) setArg(arg.name, emptyValue(arg.kind));
            }}
          >
            <option value="">Choose an argument…</option>
            <optgroup label={`${spec.step} arguments`}>
              {unused
                .filter((arg) => !COMMON_ARG_NAMES.includes(arg.name))
                .map((arg) => (
                  <option key={arg.name} value={arg.name}>
                    {arg.name} — {arg.hint}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Common (genStage) arguments">
              {unused
                .filter((arg) => COMMON_ARG_NAMES.includes(arg.name))
                .map((arg) => (
                  <option key={arg.name} value={arg.name}>
                    {arg.name} — {arg.hint}
                  </option>
                ))}
            </optgroup>
          </select>
          <span className="field-hint">
            Everything the step accepts. Anything left off falls back to the library's own default.
          </span>
        </div>
      )}
    </div>
  );
}
