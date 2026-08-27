import { HelpCircle, Plus, X } from "lucide-react";
import { useState } from "react";
import { KIND_LABEL, type ArgSpec, type ObjectField } from "../catalog";
import { closureOf, pairsOf, type MapPairs } from "../pipeline";

type Props = {
  spec: ArgSpec;
  value: unknown;
  /** What the step fills in when this argument is left off — shown as the placeholder. */
  stepDefault?: string;
  idPrefix: string;
  /** The library rejects the stage without it, so it is shown open and cannot be removed. */
  required?: boolean;
  /** What a `pickFrom: "stashNames"` argument can choose from. */
  stashNames?: string[];
  onChange: (value: unknown) => void;
  /** Omitted for the pipeline-level fields and the required ones, which cannot be removed. */
  onRemove?: () => void;
};

/**
 * One argument of one stage, rendered by its kind. The value shapes here are
 * exactly what `groovy.ts` renders and what the server stores, so nothing is
 * translated on the way out.
 */
export function ArgField({ spec, value, stepDefault, idPrefix, required, stashNames = [], onChange, onRemove }: Props) {
  const id = `${idPrefix}-${spec.name}`;
  // The step's own default beats the catalog's generic example: sonarStage
  // really does fall back to `sonar`, and showing `python311` there would be a lie.
  const placeholder = stepDefault ?? spec.placeholder;
  // Maps and object lists are several inputs, each with its own aria-label, so
  // there is nothing for a `for=` to point at — the caption is a plain label.
  const composite = spec.kind === "stringMap" || spec.kind === "objectList";
  // Old records hold `true`/`false` in what is now an expression field; show the
  // literal rather than an empty box that would silently drop it on the next edit.
  const expression = typeof value === "boolean" ? String(value) : String(value ?? "");

  return (
    <div className={`form-field jf-arg${spec.kind === "boolean" ? " jf-arg-inline" : ""}`}>
      <div className="jf-arg-head">
        <label htmlFor={composite ? undefined : id}>{spec.label ?? spec.name}</label>
        <span className="jf-kind">
          {spec.kind === "commands" ? (closureOf(value) === null ? "list" : "groovy") : KIND_LABEL[spec.kind]}
        </span>
        {required && <span className="jf-required">required</span>}
        {onRemove && (
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${spec.name}`}
            title={`Remove ${spec.name}`}
            onClick={onRemove}
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      {spec.kind === "string" && (
        <input id={id} type="text" value={String(value ?? "")} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}

      {spec.kind === "expression" && (
        <input
          id={id}
          type="text"
          className="jf-expression"
          spellCheck={false}
          value={expression}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {spec.kind === "integer" && (
        <input
          id={id}
          type="number"
          min={1}
          value={String(value ?? "")}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {spec.kind === "boolean" && (
        <label className="jf-checkbox" htmlFor={id}>
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {value === true ? "true" : "false"}
        </label>
      )}

      {spec.kind === "commands" && <Commands spec={spec} id={id} value={value} onChange={onChange} />}

      {spec.kind === "stringList" &&
        (spec.pickFrom === "stashNames" ? (
          <StashPicker spec={spec} chosen={(value as string[]) ?? []} available={stashNames} onChange={onChange} />
        ) : (
          <Lines id={id} value={value} placeholder={placeholder} onChange={onChange} />
        ))}

      {spec.kind === "stringMap" &&
        (spec.allowedKeys ? (
          <FixedKeys spec={spec} pairs={pairsOf(value)} onChange={onChange} />
        ) : (
          <MapRows spec={spec} pairs={pairsOf(value)} onChange={onChange} onDropArg={onRemove} />
        ))}

      {spec.kind === "objectList" && (
        <ObjectRows
          spec={spec}
          entries={(value as Record<string, string>[]) ?? []}
          onChange={onChange}
          onDropArg={onRemove}
        />
      )}

      <span className="field-hint">{spec.hint}</span>
    </div>
  );
}

/**
 * A textarea that grows with what is in it and cannot be dragged bigger — the
 * drag handle only ever fights the auto-size. The value is kept as the raw split
 * of the text, blank lines and all: filtering them here is what used to make
 * Enter appear to do nothing, because the empty line you just made was dropped
 * before it could be rendered back. Blanks are dropped by the generator instead.
 */
function Lines({
  id,
  value,
  placeholder,
  onChange,
  mono,
}: {
  id: string;
  value: unknown;
  placeholder?: string;
  onChange: (value: unknown) => void;
  mono?: boolean;
}) {
  const text = ((value as string[]) ?? []).join("\n");
  return (
    <textarea
      id={id}
      className={`jf-lines${mono ? " jf-expression" : ""}`}
      rows={Math.max(3, text.split("\n").length + 1)}
      value={text}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.split("\n"))}
    />
  );
}

/**
 * `unstash` names a stash some *other* stage made — the library throws if it
 * does not exist, and there is nothing to type that a list cannot offer. Only
 * earlier stages count, and a name held from a stage since deleted is still
 * shown so it can be unticked rather than silently vanishing.
 */
function StashPicker({
  spec,
  chosen,
  available,
  onChange,
}: {
  spec: ArgSpec;
  chosen: string[];
  available: string[];
  onChange: (value: string[]) => void;
}) {
  const kept = chosen.filter((name) => name.trim() && !available.includes(name));
  const options = [...available, ...kept];

  if (options.length === 0) {
    return (
      <p className="jf-note">
        Nothing to unstash yet — an earlier stage has to <code>stash</code> something first.
      </p>
    );
  }

  return (
    <div className="jf-picker">
      {options.map((name) => (
        <label className="jf-checkbox" key={name}>
          <input
            type="checkbox"
            aria-label={`${spec.name} ${name}`}
            checked={chosen.includes(name)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, name] : chosen.filter((n) => n !== name))}
          />
          {name}
          {!available.includes(name) && <span className="jf-kind">gone</span>}
        </label>
      ))}
    </div>
  );
}

/**
 * `commands` is one argument with two shapes, so the switch lives with the
 * field rather than in the add list: the same textarea holds shell lines or a
 * closure body, and flipping the switch keeps what is already in it. Empty is
 * the resting state — a step with neither is just a step with no commands.
 */
function Commands({
  spec,
  id,
  value,
  onChange,
}: {
  spec: ArgSpec;
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const closure = closureOf(value);
  const isClosure = closure !== null;

  function choose(kind: "shell" | "closure") {
    if ((kind === "closure") === isClosure) return;
    // The text carries across: the same lines usually want to become `sh '...'`
    // calls, and going back the other way is a retype either way.
    const text = isClosure ? closure! : ((value as string[]) ?? []).join("\n");
    onChange(kind === "closure" ? { closure: text } : text.split("\n"));
  }

  return (
    <>
      <div className="jf-segmented jf-commands-kind" role="group" aria-label={`${spec.name} type`}>
        <button type="button" className={isClosure ? "" : "active"} aria-pressed={!isClosure} onClick={() => choose("shell")}>
          Shell
        </button>
        <button type="button" className={isClosure ? "active" : ""} aria-pressed={isClosure} onClick={() => choose("closure")}>
          Closure
        </button>
      </div>
      {isClosure ? (
        <textarea
          id={id}
          className="jf-lines jf-expression"
          spellCheck={false}
          rows={Math.max(3, closure!.split("\n").length + 1)}
          placeholder={"sh 'npm ci'\njunit '**/target/surefire-reports/*.xml'"}
          value={closure!}
          onChange={(e) => onChange({ closure: e.target.value })}
        />
      ) : (
        <Lines id={id} value={value} placeholder={"npm ci\nnpm run build"} onChange={onChange} />
      )}
    </>
  );
}

/**
 * A map whose keys the library fixes (`resources`) is not a set of rows to add
 * and name — it is four values to fill in. Rendering it as labelled inputs means
 * the key can never be misspelled into a validator error, and an emptied box
 * drops its entry rather than leaving a blank-valued key behind.
 */
function FixedKeys({
  spec,
  pairs,
  onChange,
}: {
  spec: ArgSpec;
  pairs: MapPairs;
  onChange: (value: MapPairs) => void;
}) {
  const current = new Map(pairs);
  const keys = spec.allowedKeys ?? [];

  function set(key: string, value: string) {
    const next = new Map(current);
    if (value.trim()) next.set(key, value);
    else next.delete(key);
    // Rebuilt in allowedKeys order, so the generated Groovy does not depend on
    // which box was typed into first.
    onChange(keys.filter((k) => next.has(k)).map((k) => [k, next.get(k)!] as [string, string]));
  }

  return (
    <div className="jf-fixed-keys">
      {keys.map((key) => (
        <label className="jf-fixed-key" key={key}>
          <span>{spec.keyLabels?.[key] ?? key}</span>
          <input
            type="text"
            aria-label={`${spec.name} ${key}`}
            value={current.get(key) ?? ""}
            onChange={(e) => set(key, e.target.value)}
          />
        </label>
      ))}
    </div>
  );
}

/**
 * `?` beside a field name: the one-line hint is always on screen, the longer
 * story is behind this. A button rather than a `title=` tooltip, because a
 * tooltip cannot be opened by touch and vanishes while you read it.
 */
function FieldHelp({ label, description }: { label: string; description: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="jf-help">
      <button
        type="button"
        className="jf-help-toggle"
        aria-expanded={open}
        aria-label={`What is ${label}?`}
        onClick={() => setOpen((v) => !v)}
      >
        <HelpCircle size={13} aria-hidden="true" />
      </button>
      {open && <span className="jf-help-body">{description}</span>}
    </span>
  );
}

function MapRows({
  spec,
  pairs,
  onChange,
  onDropArg,
}: {
  spec: ArgSpec;
  pairs: MapPairs;
  onChange: (value: MapPairs) => void;
  onDropArg?: () => void;
}) {
  const rows = pairs.length ? pairs : ([["", ""]] as MapPairs);
  const set = (i: number, pair: [string, string]) => onChange(rows.map((p, n) => (n === i ? pair : p)));

  function remove(i: number) {
    const next = rows.filter((_, n) => n !== i);
    if (next.length === 0 && onDropArg) onDropArg();
    else onChange(next);
  }

  return (
    <div className="jf-rows">
      {rows.map(([k, v], i) => (
        <div className="jf-row" key={i}>
          <input
            type="text"
            placeholder="key"
            aria-label={`${spec.name} key ${i + 1}`}
            value={k}
            onChange={(e) => set(i, [e.target.value, v])}
          />
          <input
            type="text"
            placeholder="value"
            aria-label={`${spec.name} value ${i + 1}`}
            value={v}
            onChange={(e) => set(i, [k, e.target.value])}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${spec.name} row ${i + 1}`}
            onClick={() => remove(i)}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className="ghost-button jf-add-row" onClick={() => onChange([...rows, ["", ""]])}>
        <Plus size={15} aria-hidden="true" /> Add entry
      </button>
    </div>
  );
}

/**
 * A list of Groovy Maps — `secrets`, `additionalRepos`, `customPVC`. Each entry
 * is its own box with its own fields labelled and explained, rather than a row
 * of unlabelled inputs: three bare boxes reading `secret/team/service`, `token`,
 * `SERVICE_TOKEN` say nothing about which is which.
 */
function ObjectRows({
  spec,
  entries,
  onChange,
  onDropArg,
}: {
  spec: ArgSpec;
  entries: Record<string, string>[];
  onChange: (value: Record<string, string>[]) => void;
  onDropArg?: () => void;
}) {
  const fields: ObjectField[] = spec.fields ?? [];
  const blank = Object.fromEntries(fields.map((f) => [f.name, ""]));
  const rows = entries.length ? entries : [blank];

  function remove(i: number) {
    const next = rows.filter((_, n) => n !== i);
    if (next.length === 0 && onDropArg) onDropArg();
    else onChange(next);
  }

  return (
    <div className="jf-rows">
      {rows.map((entry, i) => (
        <div className="jf-entry" key={i}>
          <div className="jf-entry-head">
            <span className="jf-entry-title">
              {spec.name} #{i + 1}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${spec.name} #${i + 1}`}
              onClick={() => remove(i)}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>

          {fields.map((field) => (
            <div className="form-field jf-entry-field" key={field.name}>
              <span className="jf-entry-label">
                <label htmlFor={`${spec.name}-${i}-${field.name}`}>{field.name}</label>
                {field.required && <span className="jf-required">required</span>}
                {field.description && <FieldHelp label={field.name} description={field.description} />}
              </span>
              <input
                id={`${spec.name}-${i}-${field.name}`}
                type="text"
                aria-label={`${spec.name} #${i + 1} ${field.name}`}
                placeholder={field.placeholder ?? field.name}
                value={entry?.[field.name] ?? ""}
                onChange={(e) =>
                  onChange(rows.map((r, m) => (m === i ? { ...r, [field.name]: e.target.value } : r)))
                }
              />
              <span className="field-hint">{field.hint}</span>
            </div>
          ))}
        </div>
      ))}
      <button type="button" className="ghost-button jf-add-row" onClick={() => onChange([...rows, { ...blank }])}>
        <Plus size={15} aria-hidden="true" /> Add {spec.name} entry
      </button>
    </div>
  );
}
