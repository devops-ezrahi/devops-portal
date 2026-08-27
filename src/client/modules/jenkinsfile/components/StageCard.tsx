import { AlertTriangle, ChevronRight, GripVertical, Minimize2, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { COMMON_ARG_NAMES, KIND_LABEL, pinsRuntime, RUNTIME_ARG_NAMES, stepSpec, type ArgSpec, type StepSpec } from "../catalog";
import { emptyValue, stageLabel } from "../pipeline";
import { ArgField } from "./ArgField";
import type { JenkinsfileStage } from "../../../../server/types";

type Props = {
  stage: JenkinsfileStage;
  index: number;
  errors: string[];
  /** Stash names earlier stages declare — what `unstash` can pick from. */
  stashNames: string[];
  open: boolean;
  onToggle: () => void;
  onChange: (stage: JenkinsfileStage) => void;
  /** Focus has left the card, so whatever is wrong with it is now worth saying. */
  onLeave: () => void;
  onRemove: () => void;
} & Pick<
  React.HTMLAttributes<HTMLLIElement>,
  "draggable" | "onDragStart" | "onDragEnd" | "onDragOver"
> & { className?: string };

/**
 * One stage, edited where it sits in the pipeline. The header is the card in its
 * collapsed form — drag handle, position, what the stage is, and the controls
 * that move or remove it — and expanding it drops every argument the step takes
 * underneath, so the list you reorder and the thing you fill in are the same
 * object rather than a rail pointing at a panel.
 *
 * Every argument is on screen, always: the ones in use as fields, the rest as
 * one-line rows you click to add, which expand in place so the list never
 * reshuffles under the cursor. The three the library validates for (`title`, and
 * exactly one of `image`/`node`) are pinned open and cannot be removed.
 */
export function StageCard({
  stage,
  index,
  errors,
  stashNames,
  open,
  onToggle,
  onChange,
  onLeave,
  onRemove,
  className,
  ...drag
}: Props) {
  const spec = stepSpec(stage.step);
  const label = stageLabel(stage);

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

  return (
    <li
      className={["jf-card", open ? "open" : "", errors.length ? "has-error" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      // The scope a press outside is measured against — see `useLeaveScopes`.
      data-touch-scope={stage.id}
      // Tabbing out counts as leaving too, which a press-outside listener alone
      // would miss for a keyboard user. A *null* relatedTarget is not handled
      // here: that is a press on something unfocusable, which may well be
      // inside this very card, and the press-outside listener knows where it
      // actually landed.
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) onLeave();
      }}
      {...drag}
    >
      <div className="jf-card-head">
        <GripVertical className="jf-grip" size={16} aria-hidden="true" />
        <span className="jf-stage-index">{index + 1}</span>
        <button
          type="button"
          className="jf-card-toggle"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
          onClick={onToggle}
        >
          <ChevronRight className={`jf-group-chevron${open ? " open" : ""}`} size={15} aria-hidden="true" />
          <span className="jf-stage-text">
            <strong>{label}</strong>
            <small>{spec ? spec.description : `${stage.step} — not in the shared library`}</small>
          </span>
        </button>
        {errors.length > 0 && (
          <AlertTriangle
            className="jf-stage-warn"
            size={15}
            aria-label={`${label} has ${errors.length} problem(s)`}
          />
        )}
        <span className="jf-stage-actions">
          {/* Folding a card is a thing you do to it, so it says which — the
              chevron beside the title is the same action for the mouse. */}
          <button
            type="button"
            className="ghost-button jf-card-edit"
            aria-label={`${open ? "Minimize" : "Edit"} ${label}`}
            onClick={onToggle}
          >
            {open ? <Minimize2 size={15} aria-hidden="true" /> : <Pencil size={15} aria-hidden="true" />}
            {open ? "Minimize" : "Edit"}
          </button>
          <button type="button" className="icon-button" aria-label={`Remove ${label}`} onClick={onRemove}>
            <X size={15} aria-hidden="true" />
          </button>
        </span>
      </div>

      {open && (
        <div className="jf-card-body">
          {!spec ? (
            <p className="jf-empty">Unknown step “{stage.step}” — it is not in the shared library.</p>
          ) : (
            <StageArgs
              spec={spec}
              stage={stage}
              errors={errors}
              stashNames={stashNames}
              onSet={setArg}
              onSetAll={setArgs}
              onRemove={removeArg}
            />
          )}
        </div>
      )}
    </li>
  );
}

function StageArgs({
  spec,
  stage,
  errors,
  stashNames,
  onSet,
  onSetAll,
  onRemove,
}: {
  spec: StepSpec;
  stage: JenkinsfileStage;
  errors: string[];
  stashNames: string[];
  onSet: (name: string, value: unknown) => void;
  onSetAll: (args: Record<string, unknown>) => void;
  onRemove: (name: string) => void;
}) {
  const find = (name: string) => spec.args.find((a) => a.name === name);
  const image = find("image");
  const node = find("node");
  // The runtime is pinned only where the step actually leaves the choice open —
  // every wrapper assigns its own image before validating, so for those two
  // `image` and `node` are ordinary optional arguments in the add list.
  const runtime = pinsRuntime(spec) && image && node ? { image, node } : null;
  // Whatever else the step is pointless without belongs beside the runtime, not
  // three quarters of the way down a collapsed group — `commands` and `title` on
  // a gen stage are the stage.
  // Catalog order, except that `title` leads: it is the stage's name, and
  // reading the card should start with what the stage is called.
  const pinned = spec.args.filter((a) => a.required);
  const pinnedTitle = pinned.find((a) => a.name === "title");
  const pinnedRest = pinned.filter((a) => a.name !== "title");
  const isPinned = (a: ArgSpec) => a.required === true || (runtime !== null && RUNTIME_ARG_NAMES.includes(a.name));
  // Splitting the list into "the step's own" and "everything genStage adds" only
  // says something for a step that is a genStage wrapper. populateEnvVars is not
  // one: `envVars` is its whole argument, not a common option it happens to share.
  const wrapsGenStage = spec.args.some((a) => a.name === "title");
  const stepArgs = spec.args.filter(
    (a) => !isPinned(a) && (!wrapsGenStage || !COMMON_ARG_NAMES.includes(a.name))
  );
  const commonArgs = wrapsGenStage
    ? spec.args.filter((a) => COMMON_ARG_NAMES.includes(a.name) && !isPinned(a))
    : [];

  // `image` is the resting state: leaving both keys off is what a step with a
  // default image wants, and genStage's own error already says which is missing.
  const runsOn = node && "node" in stage.args ? "node" : "image";
  function chooseRuntime(kind: "image" | "node") {
    const { image: _i, node: _n, ...rest } = stage.args;
    onSetAll(kind === "node" ? { ...rest, node: "" } : rest);
  }

  return (
    <>
      {errors.length > 0 && (
        <ul className="jf-errors" aria-label="Stage problems">
          {errors.map((message) => (
            <li key={message}>
              <AlertTriangle size={14} aria-hidden="true" /> {message}
            </li>
          ))}
        </ul>
      )}

      {(runtime || pinned.length > 0) && (
        <div className="jf-arg-list jf-essentials">
          {pinnedTitle && (
            <ArgField
              spec={pinnedTitle}
              value={stage.args.title}
              stepDefault={spec.defaults?.title}
              idPrefix={stage.id}
              required
              onChange={(value) => onSet("title", value)}
            />
          )}

          {runtime && (
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
                    image
                  </button>
                  <button
                    type="button"
                    className={runsOn === "node" ? "active" : ""}
                    aria-pressed={runsOn === "node"}
                    onClick={() => chooseRuntime("node")}
                  >
                    node
                  </button>
                </div>
              </div>
              <ArgField
                spec={runsOn === "node" ? runtime.node : runtime.image}
                value={stage.args[runsOn]}
                stepDefault={spec.defaults?.[runsOn]}
                idPrefix={stage.id}
                required
                onChange={(value) => onSet(runsOn, value)}
              />
            </div>
          )}

          {wrapsGenStage && !runtime && !image && !node && (
            <p className="jf-note">
              This step runs on the <code>windows</code> node — it sets that itself.
            </p>
          )}

          <ArgFields
            args={pinnedRest}
            stage={stage}
            spec={spec}
            stashNames={stashNames}
            onSet={onSet}
            onRemove={onRemove}
          />
        </div>
      )}

      {stepArgs.length > 0 &&
        (wrapsGenStage ? (
          <ArgGroup
            title={`${spec.label} options`}
            args={stepArgs}
            stage={stage}
            spec={spec}
            stashNames={stashNames}
            onSet={onSet}
            onRemove={onRemove}
          />
        ) : (
          // Nothing else on the card, so a group header would only repeat its title.
          <div className="jf-arg-list jf-essentials">
            <ArgFields
              args={stepArgs}
              stage={stage}
              spec={spec}
              stashNames={stashNames}
              onSet={onSet}
              onRemove={onRemove}
            />
          </div>
        ))}

      {commonArgs.length > 0 && (
        <ArgGroup
          title="Common options"
          subtitle="From genStage — every step in the library accepts these."
          args={commonArgs}
          stage={stage}
          spec={spec}
          stashNames={stashNames}
          onSet={onSet}
          onRemove={onRemove}
        />
      )}
    </>
  );
}

function ArgGroup({
  title,
  subtitle,
  args,
  stage,
  spec,
  stashNames,
  onSet,
  onRemove,
}: {
  title: string;
  subtitle?: string;
  args: ArgSpec[];
  stage: JenkinsfileStage;
  spec: StepSpec;
  stashNames: string[];
  onSet: (name: string, value: unknown) => void;
  onRemove: (name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const inUse = args.filter((a) => a.name in stage.args).length;

  return (
    <section className="jf-group">
      <button type="button" className="jf-group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={`jf-group-chevron${open ? " open" : ""}`} size={14} aria-hidden="true" />
        <span className="jf-group-title">{title}</span>
        <span className="jf-group-count">
          {inUse ? `${inUse} of ${args.length} set` : `${args.length} available`}
        </span>
      </button>

      {open && (
        <div className="jf-arg-list">
          {subtitle && <p className="jf-note">{subtitle}</p>}
          <ArgFields
            args={args}
            stage={stage}
            spec={spec}
            stashNames={stashNames}
            onSet={onSet}
            onRemove={onRemove}
          />
        </div>
      )}
    </section>
  );
}

/** The arguments in use as fields, the rest as one-line rows you click to add. */
function ArgFields({
  args,
  stage,
  spec,
  stashNames,
  onSet,
  onRemove,
}: {
  args: ArgSpec[];
  stage: JenkinsfileStage;
  spec: StepSpec;
  stashNames: string[];
  onSet: (name: string, value: unknown) => void;
  onRemove: (name: string) => void;
}) {
  return (
    <>
      {args.map((arg) =>
        arg.required || arg.name in stage.args ? (
          <ArgField
            key={arg.name}
            spec={arg}
            value={stage.args[arg.name]}
            stepDefault={spec.defaults?.[arg.name]}
            idPrefix={stage.id}
            required={arg.required}
            stashNames={stashNames}
            onChange={(value) => onSet(arg.name, value)}
            onRemove={arg.required ? undefined : () => onRemove(arg.name)}
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
    </>
  );
}
