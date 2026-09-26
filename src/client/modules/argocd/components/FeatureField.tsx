import { Help } from "../../../Help";
import { Check, KeyRound, Link2, Plus, X } from "lucide-react";
import { useId, type ReactNode } from "react";
import type { FieldSpec, KvPair, RowCol } from "../catalog";
import type { Values } from "../values";
import { highlightFile } from "../highlight";

/**
 * One field of one feature, rendered from its `FieldKind` — the `ArgField.tsx`
 * of this module. Every shape the chart's values take is one of eight kinds, so
 * a new feature in `catalog.ts` needs no new component.
 */
export function FeatureField({
  spec,
  value,
  onChange,
  onRemove,
  from,
  ...extras
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (value: unknown) => void;
  /** Put this field back on the add list. Absent on the ones that cannot leave. */
  onRemove?: () => void;
  /** A read-only copy of a lower layer's value — named apart from this layer's own field. */
  from?: string;
} & RowExtras) {
  const id = from ? `ag-field-${from.replace(/\W+/g, "-")}-${spec.key}` : `ag-field-${spec.key}`;
  // A list, a map or a block of YAML gets the whole width of the feature; only
  // the one-line fields sit in the column grid beside each other.
  const wide = spec.kind === "rows" || spec.kind === "kv" || spec.kind === "text" || spec.kind === "yaml";
  return (
    <div className={`ag-field${wide ? " ag-field-wide" : ""}`}>
      {/* A continued list is labelled by the greyed block right above it. */}
      {!extras.bare && <span className="ag-field-label-row">
        {/* `htmlFor`, so the `?` can sit beside the label rather than inside
            it — a label wrapping a button names the button too. */}
        <label className="ag-field-label" htmlFor={id}>
          {spec.label}
          {from && <span className="sr-only"> from {from}</span>}
        </label>
        {spec.hint && (
          <Help label={spec.label}>
            <p>{spec.hint}</p>
          </Help>
        )}
        {/* The way back out of an add-list chip. Adding a field is a decision,
            and one made by mistake had no undo short of knowing which value
            the chart would have used. */}
        {onRemove && (
          <button
            type="button"
            className="ag-field-remove"
            data-undo
            aria-label={`Remove ${spec.label}`}
            title="Back to the optional list"
            onClick={onRemove}
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </span>}
      <Control spec={spec} id={id} value={value} onChange={onChange} {...extras} />
    </div>
  );
}

/** Rows a textarea needs for `text`, plus one to show there is room to type. */
const lineCount = (text: unknown): number => String(text ?? "").split("\n").length + 1;

/**
 * A file's contents, coloured by its name. A textarea cannot colour its own
 * text, so the highlighted copy sits behind a transparent one — the Jenkinsfile
 * import dialog's trick. It grows a row per line, so there is no scroll to sync.
 */
function CodeArea({
  lang,
  value,
  placeholder,
  onChange,
}: {
  lang: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="ag-code">
      <pre className="ag-textarea ag-code-shadow" aria-hidden="true">
        {/* The trailing newline matches the empty last line a textarea reserves. */}
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightFile(lang, value) + "\n" }} />
      </pre>
      <textarea
        className="ag-textarea"
        rows={Math.max(2, lineCount(value), lineCount(placeholder))}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * What a row needs beyond its own value: the names this release already
 * declares elsewhere (so a mount can offer them), and the one-press wiring that
 * turns a claim into a volume and a mount.
 */
export type RowExtras = {
  /** Row names declared by another feature of this release — for `RowCol.suggest`. */
  rowsFor?: (featureId: string) => string[];
  /** Wire this named object up as a volume plus a mount. Absent = not mountable. */
  onMount?: (name: string) => void;
  /** What is already mounted, so the offer says so instead of offering twice. */
  mounted?: Set<string>;
  /** Pull every key of this ConfigMap/Secret in as env vars. Absent = not offered. */
  onEnv?: (name: string) => void;
  /** What is already an envFrom source. */
  inEnv?: Set<string>;
  /**
   * This layer's entries of a list a lower layer already has: no label and no
   * blank placeholder entry, just its own entries and the Add button — the
   * greyed block above is where the list starts.
   */
  bare?: boolean;
  /** A greyed copy of a list that is continued below it — the Add button is the continuation's. */
  noAdd?: boolean;
};

function Control({
  spec,
  id,
  value,
  onChange,
  ...extras
}: {
  spec: FieldSpec;
  id: string;
  value: unknown;
  onChange: (value: unknown) => void;
} & RowExtras) {
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
      return <KvRows rows={(value as KvPair[]) ?? []} onChange={onChange} bare={extras.bare} noAdd={extras.noAdd} />;
    case "rows":
      return (
        <ObjectRows spec={spec} rows={(value as Values[]) ?? []} onChange={onChange} {...extras} />
      );
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
function KvRows({
  rows,
  onChange,
  bare,
  noAdd,
}: {
  rows: KvPair[];
  onChange: (rows: KvPair[]) => void;
  bare?: boolean;
  noAdd?: boolean;
}) {
  const shown = rows.length || bare ? rows : [{ k: "", v: "" }];
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
            data-undo
            // Removing the last row removes the value: without this the × on a
            // single row looks like it does nothing, since one blank row is
            // always rendered.
            onClick={() => onChange(shown.filter((_, n) => n !== i))}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      ))}
      {!noAdd && (
        <button type="button" className="ghost-button ag-add" onClick={() => onChange([...shown, { k: "", v: "" }])}>
          <Plus size={15} aria-hidden="true" /> Add
        </button>
      )}
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
function ObjectRows({
  spec,
  rows,
  onChange,
  rowsFor,
  onMount,
  mounted,
  onEnv,
  inEnv,
  bare,
  noAdd,
}: { spec: FieldSpec; rows: Values[]; onChange: (rows: Values[]) => void } & RowExtras) {
  const cols = spec.cols ?? [];
  const listId = useId();
  const list = Array.isArray(rows) ? rows : [];
  const shown = list.length || bare ? list : [{}];
  const set = (i: number, patch: Values) => onChange(shown.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <div className="ag-rows">
      {shown.map((row, i) => (
        <div className="ag-entry" key={i}>
          <div className="ag-entry-head">
            {/* An entry names itself once it has a name — a column of
                "Variables 1, Variables 2" says nothing about which is which. */}
            <span className="ag-entry-title">{entryTitle(spec, row, i)}</span>
            {/* A claim nothing mounts is storage the pod never sees, and wiring
                it up by hand means a volume in one feature and a mount in
                another. Once taken the button stays, disabled, saying so —
                an offer that silently vanishes reads as one that never was. */}
            {onMount && nameOf(row) && (
              <OfferButton
                done={!!mounted?.has(nameOf(row))}
                doneLabel="Mounted"
                doneTitle="Already mounted — see Volumes and Volume mounts"
                icon={<Link2 size={13} aria-hidden="true" />}
                label="Mount this"
                onClick={() => onMount(nameOf(row))}
              />
            )}
            {onEnv && nameOf(row) && (
              <OfferButton
                done={!!inEnv?.has(nameOf(row))}
                doneLabel="In env"
                doneTitle="Already an envFrom source"
                icon={<KeyRound size={13} aria-hidden="true" />}
                label="Use as env vars"
                onClick={() => onEnv(nameOf(row))}
              />
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Remove this entry"
              data-undo
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
              ) : col.kind === "quantity" ? (
                <Quantity
                  value={String(row[col.key] ?? "")}
                  placeholder={col.placeholder}
                  onChange={(v) => set(i, { [col.key]: v })}
                />
              ) : col.kind === "text" && col.lang ? (
                <CodeArea
                  lang={col.lang(row)}
                  value={String(row[col.key] ?? "")}
                  placeholder={col.placeholder}
                  onChange={(v) => set(i, { [col.key]: v })}
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
                <Suggested
                  col={col}
                  listId={`${listId}-${col.key}`}
                  options={col.suggest && rowsFor ? rowsFor(col.suggest(row)) : []}
                  value={String(row[col.key] ?? "")}
                  onChange={(v) => set(i, { [col.key]: v })}
                />
              )}
            </label>
          ))}
        </div>
      ))}
      {!noAdd && (
        <button type="button" className="ghost-button ag-add" onClick={() => onChange([...shown, {}])}>
          <Plus size={15} aria-hidden="true" /> {spec.addLabel ?? "Add"}
        </button>
      )}
    </div>
  );
}

const UNITS = ["Mi", "Gi", "Ti"];

/**
 * A Kubernetes size as a number and a unit, stored as the one string the chart
 * takes (`50Gi`). A unit off the menu — `500M` from an import — is added to it
 * rather than silently rewritten.
 */
function Quantity({ value, placeholder, onChange }: { value: string; placeholder?: string; onChange: (v: string) => void }) {
  const [, num = "", unit = ""] = /^\s*([0-9.]*)\s*([A-Za-z]*)\s*$/.exec(value) ?? [];
  const chosen = unit || "Gi";
  const units = UNITS.includes(chosen) ? UNITS : [...UNITS, chosen];
  // ponytail: a unit picked before any number is typed is not kept — there is no string to hold it yet.
  return (
    <span className="ag-quantity">
      <input
        type="number"
        min={0}
        step="any"
        value={num}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value ? `${e.target.value}${chosen}` : "")}
      />
      <select aria-label="unit" value={chosen} onChange={(e) => onChange(num ? `${num}${e.target.value}` : "")}>
        {units.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A one-press wiring offer on a row, or — once taken — a disabled note that it was. */
function OfferButton({
  done,
  doneLabel,
  doneTitle,
  icon,
  label,
  onClick,
}: {
  done: boolean;
  doneLabel: string;
  doneTitle: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return done ? (
    <button type="button" className="ghost-button ag-mount done" disabled title={doneTitle}>
      <Check size={13} aria-hidden="true" /> {doneLabel}
    </button>
  ) : (
    <button type="button" className="ghost-button ag-mount" onClick={onClick}>
      {icon} {label}
    </button>
  );
}

/** A row's own name, trimmed — what the mount offer is keyed on. */
const nameOf = (row: Values): string => String(row.name ?? "").trim();

/**
 * A text box that offers what this release already declares.
 *
 * A native `datalist`, not a `<select>` and not the Jenkinsfile builder's
 * combobox: the list is one column of names, and typing a name that is not on
 * it has to keep working — a ConfigMap the platform team owns is mounted the
 * same way as one this release creates.
 */
function Suggested({
  col,
  listId,
  options,
  value,
  onChange,
}: {
  col: RowCol;
  listId: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <input
        type={col.kind === "number" ? "number" : "text"}
        value={value}
        placeholder={col.placeholder}
        list={options.length ? listId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {options.length > 0 && (
        <datalist id={listId}>
          {options.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
    </>
  );
}
