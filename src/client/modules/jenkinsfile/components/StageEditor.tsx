import { AlertTriangle, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  COMMON_ARG_NAMES,
  ESSENTIAL_ARG_NAMES,
  KIND_LABEL,
  stepSpec,
  type ArgSpec,
  type StepSpec,
} from "../catalog";
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
 * Every argument the step accepts is on screen, always — the ones in use as
 * fields, the rest as one-line rows you click to add. Nothing is hidden behind a
 * dropdown, and an argument expands where it already sits, so the list never
 * reshuffles under the cursor.
 *
 * The three the library validates for (`title`, and exactly one of
 * `image`/`node`) skip that treatment: they are rendered open and cannot be
 * removed, because a stage without them does not build.
 */
export function StageEditor({ stage, errors, onChange, onRemove }: Props) {
  const spec = stepSpec(stage.step);
  if (!spec) {
    return <p className="jf-empty">Unknown step “{stage.step}” — it is not in the shared library.</p>;
  }

  const find = (name: string) => spec.args.find((a) => a.name === name);
  const title = find("title");
  const image = find("image");
  const node = find("node");
  const stepArgs = spec.args.filter((a) => !COMMON_ARG_NAMES.includes(a.name));
  const commonArgs = spec.args.filter(
    (a) => COMMON_ARG_NAMES.includes(a.name) && !ESSENTIAL_ARG_NAMES.includes(a.name)
  );

  function setArgs(args: Record<string, unknown>) {
    onChange({ ...stage, args });
  }

  function setArg(name: string, value: unknown) {
    setArgs({ ...stage.args, [name]: value });
  }

  function removeArg(name: string) {
    const { [name]: _dropped, ...rest } = stage.args;
    setArgs(rest);
  }

  // `image` is the resting state: leaving both keys off is what a step with a
  // default image wants, and genStage's own error already says which is missing.
  const runsOn = node && "node" in stage.args ? "node" : "image";
  function chooseRuntime(kind: "image" | "node") {
    const { image: _i, node: _n, ...rest } = stage.args;
    setArgs(kind === "node" ? { ...rest, node: "" } : rest);
  }

  return (
    <div className="jf-editor">
      <div className="jf-editor-head">
        <div className="jf-editor-title">
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

      <section className="jf-group">
        <div className="jf-group-head jf-group-head-static">
          <span className="jf-group-title">Essentials</span>
          <span className="jf-group-count">always written</span>
        </div>
        <div className="jf-arg-list">
          {title && (
            <ArgField
              spec={title}
              value={stage.args.title}
              stepDefault={spec.defaults?.title}
              idPrefix={stage.id}
              required
              onChange={(value) => setArg("title", value)}
            />
          )}

          {image && node ? (
            <div className="jf-runtime">
              <div className="jf-runtime-head">
                <span className="jf-arg-label">Runs on</span>
                <div className="jf-segmented" role="group" aria-label="Runs on">
                  <button
                    type="button"
                    className={runsOn === "image" ? "active" : ""}
                    aria-pressed={runsOn === "image"}
                    onClick={() => chooseRuntime("image")}
                  >
                    Container image
                  </button>
                  <button
                    type="button"
                    className={runsOn === "node" ? "active" : ""}
                    aria-pressed={runsOn === "node"}
                    onClick={() => chooseRuntime("node")}
                  >
                    Jenkins node
                  </button>
                </div>
              </div>
              <ArgField
                spec={runsOn === "node" ? node : image}
                value={stage.args[runsOn]}
                stepDefault={spec.defaults?.[runsOn]}
                idPrefix={stage.id}
                required
                onChange={(value) => setArg(runsOn, value)}
              />
            </div>
          ) : (
            <p className="jf-note">
              This step runs on the <code>windows</code> node — it sets that itself.
            </p>
          )}
        </div>
      </section>

      {stepArgs.length > 0 && (
        <ArgGroup
          title={`${spec.label} options`}
          args={stepArgs}
          stage={stage}
          spec={spec}
          onSet={setArg}
          onRemove={removeArg}
        />
      )}

      <ArgGroup
        title="Common options"
        subtitle="From genStage — every step in the library accepts these."
        args={commonArgs}
        stage={stage}
        spec={spec}
        onSet={setArg}
        onRemove={removeArg}
      />
    </div>
  );
}

function ArgGroup({
  title,
  subtitle,
  args,
  stage,
  spec,
  onSet,
  onRemove,
}: {
  title: string;
  subtitle?: string;
  args: ArgSpec[];
  stage: JenkinsfileStage;
  spec: StepSpec;
  onSet: (name: string, value: unknown) => void;
  onRemove: (name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const inUse = args.filter((a) => a.name in stage.args).length;

  return (
    <section className="jf-group">
      <button
        type="button"
        className="jf-group-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={`jf-group-chevron${open ? " open" : ""}`} size={14} aria-hidden="true" />
        <span className="jf-group-title">{title}</span>
        <span className="jf-group-count">
          {inUse ? `${inUse} of ${args.length} set` : `${args.length} available`}
        </span>
      </button>

      {open && (
        <div className="jf-arg-list">
          {subtitle && <p className="jf-note">{subtitle}</p>}
          {args.map((arg) =>
            arg.name in stage.args ? (
              <ArgField
                key={arg.name}
                spec={arg}
                value={stage.args[arg.name]}
                stepDefault={spec.defaults?.[arg.name]}
                idPrefix={stage.id}
                onChange={(value) => onSet(arg.name, value)}
                onRemove={() => onRemove(arg.name)}
              />
            ) : (
              <button
                key={arg.name}
                type="button"
                className="jf-arg-add"
                aria-label={`Add ${arg.name}`}
                onClick={() => onSet(arg.name, emptyValue(arg.kind))}
              >
                <Plus size={14} aria-hidden="true" />
                <span className="jf-arg-add-name">{arg.name}</span>
                <span className="jf-kind">{KIND_LABEL[arg.kind]}</span>
                <span className="jf-arg-add-hint">
                  {spec.defaults?.[arg.name] ? `Defaults to ${spec.defaults[arg.name]}. ` : ""}
                  {arg.hint}
                </span>
              </button>
            )
          )}
        </div>
      )}
    </section>
  );
}
