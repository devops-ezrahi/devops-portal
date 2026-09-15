import { Plus, X } from "lucide-react";
import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import { Help } from "../../../Help";
import { KIND_LABEL, type ArgSpec, type ObjectField } from "../catalog";
import { closureOf, pairsOf, type MapPairs } from "../pipeline";
import type { PickableImage } from "../api";
import { ImagePicker } from "./ImagePicker";

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
 * The images the `image` argument suggests. A context rather than a prop
 * because — unlike `stashNames`, which is computed per stage — this is one list
 * for the whole builder, and threading it would mean adding the same prop to
 * every component between the view and here.
 */
export const ImagesContext = createContext<PickableImage[]>([]);

/**
 * One argument of one stage, rendered by its kind. The value shapes here are
 * exactly what `groovy.ts` renders and what the server stores, so nothing is
 * translated on the way out.
 */
export function ArgField({ spec, value, stepDefault, idPrefix, required, stashNames = [], onChange, onRemove }: Props) {
  const images = useContext(ImagesContext);
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
  const suggesting = spec.pickFrom === "images" && images.length > 0;

  return (
    <div className={`form-field jf-arg${spec.kind === "boolean" ? " jf-arg-inline" : ""}`}>
      <div className="jf-arg-head">
        {/* The `?` sits beside the label, never inside it: a label wrapping a
            button names the button too, and on a boolean argument a press on it
            would toggle the checkbox. */}
        <label htmlFor={composite ? undefined : id}>{spec.label ?? spec.name}</label>
        <Help label={spec.label ?? spec.name}>
          <p>{spec.hint}</p>
        </Help>
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

      {spec.kind === "string" &&
        // The picker is the same text field with a list attached, so an
        // unreachable Artifactory leaves an ordinary input rather than an
        // empty dropdown.
        (suggesting ? (
          <ImagePicker
            id={id}
            value={String(value ?? "")}
            placeholder={placeholder}
            images={images}
            onChange={onChange}
          />
        ) : (
          <input id={id} type="text" value={String(value ?? "")} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        ))}

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
          <Lines id={id} name={spec.name} value={value} placeholder={placeholder} onChange={onChange} />
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
    </div>
  );
}

/**
 * One box per entry, the same shape `MapRows` and `ObjectRows` use — a list is
 * a list of things, and a textarea made every entry look like one paragraph
 * whose line breaks happened to matter.
 *
 * Enter adds the next box and Backspace in an empty one removes it, so a list
 * is still typed straight through without reaching for the mouse; a multi-line
 * paste splits across boxes rather than collapsing into one, which is what
 * pasting out of an existing Jenkinsfile does. Blank entries are kept in the
 * value (removing them under the cursor is what used to make Enter look
 * broken) and dropped by the generator.
 */
function Lines({
  id,
  name,
  value,
  placeholder,
  onChange,
  mono,
}: {
  id: string;
  /** The argument's name, for the rows after the first — which the label covers. */
  name: string;
  value: unknown;
  placeholder?: string;
  onChange: (value: unknown) => void;
  mono?: boolean;
}) {
  const items = (value as string[]) ?? [];
  const rows = items.length ? items : [""];
  // Which box to put the cursor in after the next render — adding a row is
  // useless if the typing does not carry on into it.
  const [focus, setFocus] = useState<number | null>(null);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useLayoutEffect(() => {
    if (focus === null) return;
    boxes.current[Math.min(focus, rows.length - 1)]?.focus();
    setFocus(null);
  }, [focus, rows.length]);

  function replace(next: string[], cursor?: number) {
    onChange(next);
    if (cursor !== undefined) setFocus(cursor);
  }

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === "Enter") {
      e.preventDefault();
      replace([...rows.slice(0, i + 1), "", ...rows.slice(i + 1)], i + 1);
    } else if (e.key === "Backspace" && rows[i] === "" && rows.length > 1) {
      e.preventDefault();
      replace(rows.filter((_, n) => n !== i), Math.max(0, i - 1));
    }
  }

  // The placeholder is written as the multi-line example it used to be shown
  // as, so one line of it belongs in each of the first boxes.
  const hints = (placeholder ?? "").split("\n");

  return (
    <div className="jf-rows">
      {rows.map((line, i) => (
        <div className="jf-row jf-list-row" key={i}>
          <input
            id={i === 0 ? id : undefined}
            type="text"
            className={mono ? "jf-expression" : undefined}
            spellCheck={false}
            ref={(el) => {
              boxes.current[i] = el;
            }}
            aria-label={i === 0 ? undefined : `${name} ${i + 1}`}
            placeholder={hints[i]}
            value={line}
            onChange={(e) => replace(rows.map((l, n) => (n === i ? e.target.value : l)))}
            onKeyDown={(e) => onKeyDown(e, i)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (!text.includes("\n")) return;
              // A list pasted out of a file arrives as many lines; dropping them
              // into one box would silently join commands together.
              e.preventDefault();
              const pasted = text.split("\n");
              replace([...rows.slice(0, i), ...pasted, ...rows.slice(i + 1)], i + pasted.length - 1);
            }}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove ${name} ${i + 1}`}
            onClick={() => replace(rows.length > 1 ? rows.filter((_, n) => n !== i) : [""])}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className="ghost-button jf-add-row" onClick={() => replace([...rows, ""], rows.length)}>
        <Plus size={15} aria-hidden="true" /> Add entry
      </button>
    </div>
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
        <Lines id={id} name={spec.name} value={value} placeholder={"npm ci\nnpm run build"} onChange={onChange} />
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
                <Help label={field.name}>
                  <p>{field.hint}</p>
                  {field.description && <p>{field.description}</p>}
                </Help>
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
