import { Plus, X } from "lucide-react";
import type { ArgSpec } from "../catalog";
import { pairsOf, type MapPairs } from "../pipeline";

type Props = {
  spec: ArgSpec;
  value: unknown;
  /** What the step fills in when this argument is left off — shown as the placeholder. */
  stepDefault?: string;
  idPrefix: string;
  onChange: (value: unknown) => void;
  /** Omitted for the pipeline-level fields, which cannot be removed. */
  onRemove?: () => void;
};

/**
 * One argument of one stage, rendered by its kind. The value shapes here are
 * exactly what `groovy.ts` renders and what the server stores, so nothing is
 * translated on the way out.
 */
export function ArgField({ spec, value, stepDefault, idPrefix, onChange, onRemove }: Props) {
  const id = `${idPrefix}-${spec.name}`;
  const placeholder = spec.placeholder ?? stepDefault;
  // Maps and object lists are several inputs, each with its own aria-label, so
  // there is nothing for a `for=` to point at — the caption is a plain label.
  const composite = spec.kind === "stringMap" || spec.kind === "objectList";

  return (
    <div className={`form-field jf-arg${spec.kind === "boolean" ? " jf-arg-inline" : ""}`}>
      <div className="jf-arg-head">
        <label htmlFor={composite ? undefined : id}>{spec.label ?? spec.name}</label>
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

      {spec.kind === "stringList" && (
        <textarea
          id={id}
          className="jf-lines"
          // +1 so there is always an empty line to type on, capped so a long
          // command list scrolls instead of pushing the preview off screen.
          rows={Math.min(10, Math.max(3, ((value as string[]) ?? []).length + 1))}
          value={((value as string[]) ?? []).join("\n")}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.split("\n"))}
        />
      )}

      {spec.kind === "stringMap" && <MapRows spec={spec} pairs={pairsOf(value)} onChange={onChange} />}

      {spec.kind === "objectList" && (
        <ObjectRows spec={spec} entries={(value as Record<string, string>[]) ?? []} onChange={onChange} />
      )}

      <span className="field-hint">{spec.hint}</span>
    </div>
  );
}

function MapRows({
  spec,
  pairs,
  onChange,
}: {
  spec: ArgSpec;
  pairs: MapPairs;
  onChange: (value: MapPairs) => void;
}) {
  const rows = pairs.length ? pairs : ([["", ""]] as MapPairs);
  const set = (i: number, pair: [string, string]) => onChange(rows.map((p, n) => (n === i ? pair : p)));

  return (
    <div className="jf-rows">
      {rows.map(([k, v], i) => (
        <div className="jf-row" key={i}>
          {spec.allowedKeys ? (
            <select
              aria-label={`${spec.name} key ${i + 1}`}
              value={k}
              onChange={(e) => set(i, [e.target.value, v])}
            >
              <option value="">(key)</option>
              {spec.allowedKeys.map((allowed) => (
                <option key={allowed} value={allowed}>
                  {allowed}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              placeholder="key"
              aria-label={`${spec.name} key ${i + 1}`}
              value={k}
              onChange={(e) => set(i, [e.target.value, v])}
            />
          )}
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
            onClick={() => onChange(rows.filter((_, n) => n !== i))}
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

function ObjectRows({
  spec,
  entries,
  onChange,
}: {
  spec: ArgSpec;
  entries: Record<string, string>[];
  onChange: (value: Record<string, string>[]) => void;
}) {
  const blank = Object.fromEntries((spec.fields ?? []).map((f) => [f.name, ""]));
  const rows = entries.length ? entries : [blank];

  return (
    <div className="jf-rows">
      {rows.map((entry, i) => (
        <fieldset className="jf-object" key={i}>
          <legend>
            {spec.name} #{i + 1}
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${spec.name} #${i + 1}`}
              onClick={() => onChange(rows.filter((_, n) => n !== i))}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </legend>
          {(spec.fields ?? []).map((field) => (
            <input
              key={field.name}
              type="text"
              aria-label={`${spec.name} #${i + 1} ${field.name}`}
              placeholder={field.placeholder ?? field.name}
              value={entry?.[field.name] ?? ""}
              onChange={(e) =>
                onChange(rows.map((r, m) => (m === i ? { ...r, [field.name]: e.target.value } : r)))
              }
            />
          ))}
        </fieldset>
      ))}
      <button type="button" className="ghost-button jf-add-row" onClick={() => onChange([...rows, { ...blank }])}>
        <Plus size={15} aria-hidden="true" /> Add {spec.name} entry
      </button>
    </div>
  );
}
