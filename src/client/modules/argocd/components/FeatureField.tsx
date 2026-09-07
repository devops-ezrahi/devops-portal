import { Plus, X } from "lucide-react";
import type { FieldSpec, KvPair } from "../catalog";
import type { Values } from "../values";

/**
 * One field of one feature, rendered from its `FieldKind` — the `ArgField.tsx`
 * of this module. Every shape the chart's values take is one of eight kinds, so
 * a new feature in `catalog.ts` needs no new component.
 */
export function FeatureField({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `ag-field-${spec.key}`;
  // A list, a map or a block of YAML gets the whole width of the feature; only
  // the one-line fields sit in the column grid beside each other.
  const wide = spec.kind === "rows" || spec.kind === "kv" || spec.kind === "text" || spec.kind === "yaml";
  return (
    <div className={`ag-field${wide ? " ag-field-wide" : ""}`}>
      <label className="ag-field-label" htmlFor={id}>
        {spec.label}
      </label>
      <Control spec={spec} id={id} value={value} onChange={onChange} />
      {spec.hint && <p className="ag-hint">{spec.hint}</p>}
    </div>
  );
}

/** Rows a textarea needs for `text`, plus one to show there is room to type. */
const lineCount = (text: unknown): number => String(text ?? "").split("\n").length + 1;

function Control({
  spec,
  id,
  value,
  onChange,
}: {
  spec: FieldSpec;
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (spec.kind) {
    case "boolean":
      return (
        <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      );
    case "number":
      return (
        <input
          id={id}
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={spec.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "select":
      // A select with nothing set shows the chart's own default rather than a
      // blank box. The value stays absent from the document, which is right —
      // the chart applies that default itself.
      return (
        <select id={id} value={String(value ?? spec.def ?? "")} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt === "" ? "—" : opt}
            </option>
          ))}
        </select>
      );
    case "text":
    case "yaml":
      return (
        <textarea
          id={id}
          className="ag-textarea"
          // Grows with its content — and with the placeholder, or a four-line
          // example sits clipped in a three-row box before anything is typed.
          rows={Math.max(3, lineCount(value), lineCount(spec.placeholder))}
          value={String(value ?? "")}
          placeholder={spec.placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "kv":
      return <KvRows rows={(value as KvPair[]) ?? []} onChange={onChange} />;
    case "rows":
      return <ObjectRows spec={spec} rows={(value as Values[]) ?? []} onChange={onChange} />;
    default:
      return (
        <input
          id={id}
          type="text"
          value={String(value ?? "")}
          placeholder={spec.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Key/value pairs, not an object: an object cannot hold a half-typed key rename. */
function KvRows({ rows, onChange }: { rows: KvPair[]; onChange: (rows: KvPair[]) => void }) {
  const shown = rows.length ? rows : [{ k: "", v: "" }];
  const set = (i: number, patch: Partial<KvPair>) =>
    onChange(shown.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="ag-rows">
      {shown.map((row, i) => (
        <div className="ag-row" key={i}>
          <input aria-label="key" value={row.k} placeholder="key" onChange={(e) => set(i, { k: e.target.value })} />
          <input aria-label="value" value={row.v} placeholder="value" onChange={(e) => set(i, { v: e.target.value })} />
          <button
            type="button"
            className="icon-button"
            aria-label="Remove this entry"
            // Removing the last row removes the value: without this the × on a
            // single row looks like it does nothing, since one blank row is
            // always rendered.
            onClick={() => onChange(shown.filter((_, n) => n !== i))}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className="ghost-button ag-add" onClick={() => onChange([...shown, { k: "", v: "" }])}>
        <Plus size={15} aria-hidden="true" /> Add
      </button>
    </div>
  );
}

/** What an entry calls itself: its own name if it has one, else its position. */
function entryTitle(spec: FieldSpec, row: Values, index: number): string {
  const named = spec.cols?.find((c) => c.key === "name" || c.key === "host" || c.key === "secretName");
  const value = named ? String(row[named.key] ?? "").trim() : "";
  // Just the position when it has no name yet: the field's label sits directly
  // above the box, so repeating it inside reads as a third name for one thing.
  return value || `#${index + 1}`;
}

/** A list of maps is a list of boxes — three bare inputs say nothing about which is which. */
function ObjectRows({ spec, rows, onChange }: { spec: FieldSpec; rows: Values[]; onChange: (rows: Values[]) => void }) {
  const cols = spec.cols ?? [];
  const shown = rows.length ? rows : [{}];
  const set = (i: number, patch: Values) => onChange(shown.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="ag-rows">
      {shown.map((row, i) => (
        <div className="ag-entry" key={i}>
          <div className="ag-entry-head">
            {/* An entry names itself once it has a name — a column of
                "Variables 1, Variables 2" says nothing about which is which. */}
            <span className="ag-entry-title">{entryTitle(spec, row, i)}</span>
            <button
              type="button"
              className="icon-button"
              aria-label="Remove this entry"
              onClick={() => onChange(shown.filter((_, n) => n !== i))}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {cols.filter((col) => !col.when || col.when(row)).map((col) => (
            <label className="ag-entry-field" key={col.key}>
              <span>{col.label}</span>
              {col.kind === "select" ? (
                <select value={String(row[col.key] ?? "")} onChange={(e) => set(i, { [col.key]: e.target.value })}>
                  {(col.options ?? []).map((opt) => (
                    <option key={opt} value={opt}>
                      {opt === "" ? "—" : opt}
                    </option>
                  ))}
                </select>
              ) : col.kind === "boolean" ? (
                <input
                  type="checkbox"
                  checked={!!row[col.key]}
                  onChange={(e) => set(i, { [col.key]: e.target.checked })}
                />
              ) : col.kind === "text" ? (
                <textarea
                  className="ag-textarea"
                  rows={Math.max(2, lineCount(row[col.key]), lineCount(col.placeholder))}
                  value={String(row[col.key] ?? "")}
                  placeholder={col.placeholder}
                  spellCheck={false}
                  onChange={(e) => set(i, { [col.key]: e.target.value })}
                />
              ) : (
                <input
                  type={col.kind === "number" ? "number" : "text"}
                  value={String(row[col.key] ?? "")}
                  placeholder={col.placeholder}
                  onChange={(e) => set(i, { [col.key]: e.target.value })}
                />
              )}
            </label>
          ))}
        </div>
      ))}
      <button type="button" className="ghost-button ag-add" onClick={() => onChange([...shown, {}])}>
        <Plus size={15} aria-hidden="true" /> {spec.addLabel ?? "Add"}
      </button>
    </div>
  );
}
