import { ArrowUpRight, ChevronDown, ChevronRight, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { BY_ID, CATEGORIES, FEATURES, defaultValues, primaryFields } from "../catalog";
import { buildValues } from "../build";
import { toYaml } from "../yaml";
import { Help } from "../../../Help";
import { FeatureField } from "./FeatureField";
import type { FeatureSpec, FeatureState, FieldSpec } from "../catalog";
import type { Problem } from "../checks";
import type { Values } from "../values";

/**
 * One feature's worth of what a lower layer already says, and which layer that
 * is — the note above the greyed block links there, and in a namespace override
 * the two are mixed: most of it is base, but a feature only the tree's defaults
 * set is not base's to change.
 */
export type Inherited = { state: FeatureState; from: "defaults" | "base" };

/** The features a release is not a release without — pinned above the categories. */
const REQUIRED = FEATURES.filter((f) => f.req);
const OPTIONAL = FEATURES.filter((f) => !f.req);

/** Append a named row to one feature's `items`, switching it on — unless that name is already there. */
function addRow(features: Record<string, FeatureState>, id: string, row: Values) {
  const v = features[id]?.v ?? defaultValues(id);
  const rows = Array.isArray(v.items) ? (v.items as Values[]) : [];
  if (rows.some((r) => String(r.name ?? "").trim() === row.name)) return;
  features[id] = { on: true, v: { ...v, items: [...rows, row] } };
}

/** Whether a field holds anything worth showing on screen without being asked for. */
function hasValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.some((row) => Object.values(row ?? {}).some(hasValue));
  return true;
}

/**
 * Every chart feature is reachable, but only what you have to decide is on
 * screen: the required features are pinned open at the top, the rest are
 * one-line rows you tick to add, and inside an open feature the fields the
 * chart already defaults sit on an add list until they hold something. Same
 * rule the Jenkinsfile builder follows for a step's arguments.
 */
export function FeatureEditor({
  features,
  scopeLabel,
  isBase,
  extraValues,
  extraError,
  overriding,
  jump,
  onJumped,
  inherited,
  onOpenInherited,
  problems,
  onChange,
  onExtraChange,
}: {
  features: Record<string, FeatureState>;
  scopeLabel: string;
  /** The base layer hides the fields only a namespace should answer — see `FieldSpec.ns`. */
  isBase: boolean;
  extraValues: string;
  extraError: string | null;
  /** Features whose value differs from base — marked with the same dot the namespace tile carries. */
  overriding?: Set<string>;
  /** A feature to open and scroll to, from a press on a microservice card's chip. */
  jump?: { feature: string; n: number };
  /**
   * The jump was made — clear it. The editor remounts on every layer or
   * microservice press, and a jump still held would replay its scroll on each.
   */
  onJumped?: () => void;
  /**
   * What the layers under this one already say — the tree's defaults in base,
   * those plus the microservice's base in a namespace override. Shown greyed,
   * not editable: it deploys here, but it is not this layer's decision, and
   * reading the whole document means reading it in one place.
   */
  inherited?: Record<string, Inherited>;
  /** Where a fragment is editable. Pressing the note above it goes there. */
  onOpenInherited?: (from: "defaults" | "base") => void;
  /** The checks for this scope, so the one about a field is also beside it. */
  problems?: Problem[];
  onChange: (features: Record<string, FeatureState>) => void;
  onExtraChange: (text: string) => void;
}) {
  /**
   * A category opens when it holds something, so a namespace override lands on
   * the two sections it actually uses rather than on forty-five collapsed ones
   * — and the generated files stay within reach of the form. Nothing is open on
   * a release nothing is set on yet, because the required block above is where
   * you start.
   */
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(OPTIONAL.filter((f) => features[f.id]?.on || inherited?.[f.id]?.state.on).map((f) => f.cat))
  );

  /**
   * Pressing a chip on a microservice card lands here. The category has to be
   * opened before the card exists to scroll to, so the scroll waits a frame.
   * `n` is what makes pressing the same chip twice jump twice — the feature id
   * alone would be unchanged and the effect would not re-run.
   */
  useEffect(() => {
    if (!jump) return;
    const spec = BY_ID[jump.feature];
    if (!spec) return;
    setOpen((prev) => new Set(prev).add(spec.cat));
    const timer = setTimeout(() => {
      onJumped?.();
      const el = document.querySelector<HTMLElement>(`[data-feature-card="${jump.feature}"]`);
      if (!el) return;
      // Optional call: opening the category is the part that matters, and not
      // every environment implements scrolling (jsdom does not).
      el.scrollIntoView?.({ behavior: "smooth", block: "center" });
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 1400);
    }, 60);
    return () => clearTimeout(timer);
  }, [jump?.feature, jump?.n]);

  function toggleCategory(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggle(id: string, on: boolean) {
    const v = features[id]?.v ?? defaultValues(id);
    // Ticking a feature on *is* `enabled: true`. A `false` left underneath from
    // an import or an earlier edit would otherwise emit a Service that renders
    // nothing — which is the opposite of what the tick just asked for.
    onChange({ ...features, [id]: { on, v: on && "enabled" in v ? { ...v, enabled: true } : v } });
  }

  /**
   * Drop a feature out of this layer entirely, so the microservice falls back
   * to whatever base says. Not `on: false` — that is "off here", which in an
   * override file is a different statement from "not overridden here".
   */
  function removeOverride(id: string) {
    const next = { ...features };
    delete next[id];
    onChange(next);
  }

  /** The rows one feature holds, whichever `rows` field it keeps them in. */
  function rowsIn(id: string): Values[] {
    const v = features[id]?.v ?? {};
    return (BY_ID[id]?.fields ?? [])
      .filter((f) => f.kind === "rows")
      .flatMap((f) => (Array.isArray(v[f.key]) ? (v[f.key] as Values[]) : []));
  }

  /** The names it declares — what a mount, or a volume's source, offers. */
  const rowsFor = (id: string): string[] =>
    rowsIn(id)
      .map((r) => String(r.name ?? "").trim())
      .filter(Boolean);

  /**
   * Wire a claim, ConfigMap or Secret into the container: the volume that
   * carries it and the mount that lands it, in one press.
   *
   * It is two features away from where the object was created, and a claim
   * nothing mounts is storage the pod never sees — so the offer sits on the row
   * itself. The `mountPath` is deliberately left empty: where it lands is the
   * one thing nobody can guess, and it is the next field on screen.
   */
  function mountObject(kind: string, name: string) {
    const next = { ...features };
    addRow(next, "volumes", { name, kind, src: name });
    addRow(next, "mounts", { name, mountPath: "" });
    onChange(next);
    reveal("volumes", "mounts");
  }

  /**
   * Open the categories a one-press wiring just wrote into. A ConfigMap's env
   * vars land under Container and its volume under Storage — both usually
   * collapsed — and a row added out of sight reads as a press that did nothing.
   */
  function reveal(...ids: string[]) {
    setOpen((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => BY_ID[id] && next.add(BY_ID[id].cat));
      return next;
    });
  }

  /** The other way a ConfigMap or Secret reaches the container: every key as an env var. */
  function envFromObject(kind: string, name: string) {
    const next = { ...features };
    addRow(next, "envfrom", { name, type: kind === "secret" ? "secretRef" : "configMapRef" });
    onChange(next);
    reveal("envfrom");
  }

  /** What is already wired, so each offer says it was taken rather than offering twice. */
  const mountedNames = new Set(rowsFor("mounts"));
  const envNames = new Set(rowsFor("envfrom"));

  /**
   * A card's border says what is wrong with it — a problem, or an override
   * carried here — so the thing being warned about is outlined, not dotted.
   */
  function tone(id: string): string {
    const mine = (problems ?? []).filter((p) => p.feature === id);
    if (mine.some((p) => p.level === "bad")) return " has-bad";
    if (mine.length) return " has-warn";
    return overriding?.has(id) ? " overridden" : "";
  }

  function setField(id: string, key: string, value: unknown) {
    const state = features[id] ?? { on: true, v: defaultValues(id) };
    onChange({ ...features, [id]: { ...state, on: true, v: { ...state.v, [key]: value } } });
  }

  return (
    <div className="ag-features">
      <section className="ag-category" aria-label="Required">
        <h4 className="ag-category-name ag-required-head">Required</h4>
        {REQUIRED.map((spec) => (
          <div className={`ag-feature on ag-feature-required${tone(spec.id)}`} key={spec.id} data-feature-card={spec.id}>
            <div className="ag-feature-head">
              <span className="ag-feature-name">{spec.name}</span>
              <FeatureHelp spec={spec} />
              {overriding?.has(spec.id) && (
                <OverrideLight name={spec.name} onRemove={() => removeOverride(spec.id)} />
              )}
            </div>
            <FeatureBody
              spec={spec}
              state={features[spec.id]}
              isBase={isBase}
              onField={setField}
              rowsFor={rowsFor}
              mounted={mountedNames}
              onMount={mountObject}
              inEnv={envNames}
              onEnv={envFromObject}
              inherited={inherited?.[spec.id]}
              onOpenInherited={onOpenInherited}
              problems={problems}
            />
          </div>
        ))}
      </section>

      {CATEGORIES.map((cat) => {
        const specs = OPTIONAL.filter((f) => f.cat === cat.id);
        if (!specs.length) return null;
        const count = specs.filter((spec) => features[spec.id]?.on || inherited?.[spec.id]?.state.on).length;
        const shown = open.has(cat.id);
        return (
          <section className="ag-category" key={cat.id} aria-label={cat.name}>
            {/* So a collapsed category still says it holds an override. */}
            <button
              type="button"
              className={`ag-category-head${specs.some((spec) => overriding?.has(spec.id)) ? " overridden" : ""}`}
              aria-expanded={shown}
              onClick={() => toggleCategory(cat.id)}
            >
              {shown ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              <span className="ag-category-name">{cat.name}</span>
              {count > 0 && <span className="ag-category-count">{count} on</span>}
            </button>
            {shown && specs.map((spec) => {
              const state = features[spec.id];
              const on = !!state?.on;
              // A feature nothing here sets but the tree's defaults do is still
              // in this microservice's file, so the card has to be open — an
              // unticked box beside a value that deploys is the invisible-value
              // problem `enabled` already taught this module about.
              const fromBelow = !!inherited?.[spec.id]?.state.on;
              return (
                <div
                  className={`ag-feature${on || fromBelow ? " on" : ""}${tone(spec.id)}`}
                  key={spec.id}
                  data-feature-card={spec.id}
                >
                  {/* The `?` sits beside the label, never inside it: a button
                      is a labelable element, so a label wrapping one names the
                      button as well as the field — and a press on it would
                      toggle the checkbox. */}
                  <div className="ag-feature-head">
                    <label className="ag-feature-label">
                      <input type="checkbox" checked={on} onChange={(e) => toggle(spec.id, e.target.checked)} />
                      <span className="ag-feature-name">{spec.name}</span>
                    </label>
                    <FeatureHelp spec={spec} />
                    {overriding?.has(spec.id) && (
                      <OverrideLight name={spec.name} onRemove={() => removeOverride(spec.id)} />
                    )}
                  </div>
                  {(on || fromBelow) && (
                    <FeatureBody
                      spec={spec}
                      state={state}
                      isBase={isBase}
                      onField={setField}
                      rowsFor={rowsFor}
                      mounted={mountedNames}
                      onMount={mountObject}
                      inEnv={envNames}
                      onEnv={envFromObject}
                      inherited={inherited?.[spec.id]}
                      onOpenInherited={onOpenInherited}
                      problems={problems}
                    />
                  )}
                </div>
              );
            })}
          </section>
        );
      })}

      <section className="ag-category" aria-label="Extra values">
        <h4 className="ag-category-name">
          Extra values
          <Help label="extra values">
            <p>Raw YAML merged into {scopeLabel}, last and winning.</p>
            <p>
              The escape hatch, and where an import's unrecognised keys land — so anything the catalog cannot model
              still reaches the file.
            </p>
          </Help>
        </h4>
        <textarea
          className="ag-textarea"
          aria-label="Extra values YAML"
          rows={Math.max(4, extraValues.split("\n").length + 1)}
          value={extraValues}
          spellCheck={false}
          placeholder={"podAnnotations:\n  prometheus.io/scrape: \"true\""}
          onChange={(e) => onExtraChange(e.target.value)}
        />
        {extraError && <p className="ag-error">{extraError}</p>}
      </section>
    </div>
  );
}

/**
 * The orange light on a feature that differs from base — and, behind it, what
 * that means plus the way out. An override is a line someone has to keep in
 * step with base forever, so the popover says to drop it if it is not earning
 * that, and does it in one press.
 */
function OverrideLight({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <Help label={`the override on ${name}`} interactive trigger={<span className="ag-override-tag">override</span>}>
      <p>
        <strong>{name}</strong> is set differently here, so this namespace deploys its own value instead of the base
        one.
      </p>
      <p>Every override is a second copy to keep in step. Drop it unless this namespace really needs to differ.</p>
      {/* Both, and it is idempotent: the press closes the popover by removing
          the light it hangs off, so the click half often never arrives. */}
      <button type="button" className="ghost-button ag-override-remove" onMouseDown={onRemove} onClick={onRemove}>
        Remove override
      </button>
    </Help>
  );
}

/**
 * A feature's blurb and its notes, behind the `?` beside its name.
 *
 * They used to sit on the page: a sentence under every one of forty-five
 * feature names, plus up to three notes under an open one. Every line was
 * worth saying and the stack of them was still a wall — and the field you came
 * to change was below it.
 */
function FeatureHelp({ spec }: { spec: FeatureSpec }) {
  return (
    <Help label={spec.name}>
      <p>{spec.blurb}</p>
      {spec.notes?.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </Help>
  );
}

/**
 * One feature's fields. A field is on screen when it is primary or already
 * holds something; the rest are chips you press to add, so switching a feature
 * on shows the two decisions it needs rather than eleven inputs the chart has
 * already answered for you.
 */
function FeatureBody({
  spec,
  state,
  isBase,
  onField,
  rowsFor,
  mounted,
  onMount,
  inEnv,
  onEnv,
  inherited,
  onOpenInherited,
  problems,
}: {
  spec: FeatureSpec;
  state: FeatureState | undefined;
  isBase: boolean;
  onField: (id: string, key: string, value: unknown) => void;
  rowsFor: (featureId: string) => string[];
  mounted: Set<string>;
  onMount: (kind: string, name: string) => void;
  inEnv: Set<string>;
  onEnv: (kind: string, name: string) => void;
  inherited?: Inherited;
  onOpenInherited?: (from: "defaults" | "base") => void;
  problems?: Problem[];
}) {
  // Local, and keyed by field: pressing "add" is a request to see the field,
  // not a value, so it must not be written into the document.
  const [added, setAdded] = useState<Set<string>>(new Set());
  // A field marked `ns` is not base's decision to make, so base is not offered
  // it — but one that already holds a value still shows, or the value would be
  // deployed by something nobody can see.
  const fields = spec.fields.filter((f) => !f.ns || !isBase || hasValue(state?.v?.[f.key]));
  // Computed over what is actually on offer: with `nameOverride` gone in base,
  // the next field is what the feature opens on, not nothing.
  const primary = new Set(primaryFields({ ...spec, fields }).map((f) => f.key));
  // A field still sitting on its own default is not "filled in" — it is the
  // chart's answer, not anyone's decision, so it stays on the add list even
  // though `defaultValues` put it in the state when the feature was switched on.
  const isShown = (f: FieldSpec) => {
    const value = state?.v?.[f.key];
    if (primary.has(f.key) || added.has(f.key)) return true;
    // An unticked box is only "filled in" when it contradicts a default that is
    // `true` — an import writes every key it reads, so plain `false` on a field
    // that defaults to off is the absence of a decision, not one.
    if (value === false) return f.def === true;
    return hasValue(value) && value !== f.def;
  };
  // `enabled` is never offered: ticking the feature is what switches it on, and
  // its emit writes `enabled: true` regardless. It still *shows* when it holds
  // `false` — an imported document saying so must not become an invisible value.
  const rest = fields.filter((f) => !isShown(f) && f.key !== "enabled");

  // What the tree's defaults put in this file, as the values themselves rather
  // than as a second set of controls: every field kind is covered by one block,
  // and a disabled input still reads as something you might be able to type in.
  const below = inherited?.state.on ? toYaml(buildValues({ [spec.id]: inherited.state })) : "";

  // The problems list sits under the whole form, so a warning about this
  // feature is read a screen away from the field it names. It is repeated here
  // — pressing it there is what scrolls to this card, and arriving at a card
  // with no sign of why is the other half of the same complaint.
  const mine = (problems ?? []).filter((p) => p.feature === spec.id);

  return (
    <div className="ag-feature-body">
      {mine.length > 0 && (
        <ul className="ag-feature-problems">
          {mine.map((p) => (
            <li key={p.text} className={p.level}>
              <TriangleAlert size={13} aria-hidden="true" /> {p.text}
            </li>
          ))}
        </ul>
      )}
      {below && (
        <div className="ag-inherited">
          <button
            type="button"
            className="ag-inherited-link"
            onClick={() => onOpenInherited?.(inherited!.from)}
          >
            <ArrowUpRight size={12} aria-hidden="true" />{" "}
            {inherited!.from === "defaults" ? "from the tree's Defaults" : "from the base values"}
          </button>
          <pre>{below}</pre>
        </div>
      )}
      {fields.filter(isShown).map((field) => (
        <FeatureField
          key={field.key}
          spec={field}
          value={state?.v?.[field.key]}
          onChange={(value) => onField(spec.id, field.key, value)}
          rowsFor={rowsFor}
          mounted={mounted}
          onMount={spec.mountable ? (name) => onMount(spec.mountable!, name) : undefined}
          inEnv={inEnv}
          // A claim is storage, not settings — only a ConfigMap or Secret can be env vars.
          onEnv={spec.mountable && spec.mountable !== "persistentVolumeClaim" ? (name) => onEnv(spec.mountable!, name) : undefined}
          // A field added by hand can be put back on the add list. Removing it
          // resets it to the chart's own answer, which is what makes it fall
          // off `isShown` again — dropping it from `added` alone would leave
          // whatever was typed emitting from a field nobody can see.
          onRemove={
            primary.has(field.key)
              ? undefined
              : () => {
                  setAdded((prev) => {
                    const next = new Set(prev);
                    next.delete(field.key);
                    return next;
                  });
                  onField(spec.id, field.key, field.def);
                }
          }
        />
      ))}
      {rest.length > 0 && (
        <div className="ag-more">
          <span className="ag-more-label">Optional:</span>
          {rest.map((field) => (
            <button
              type="button"
              className="ag-more-chip"
              key={field.key}
              onClick={() => setAdded((prev) => new Set(prev).add(field.key))}
            >
              <Plus size={12} aria-hidden="true" /> {field.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
