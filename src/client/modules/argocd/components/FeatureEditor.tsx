import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { BY_ID, CATEGORIES, FEATURES, defaultValues, primaryFields } from "../catalog";
import { Help } from "../../../Help";
import { FeatureField } from "./FeatureField";
import type { FeatureSpec, FeatureState, FieldSpec } from "../catalog";

/** The features a release is not a release without — pinned above the categories. */
const REQUIRED = FEATURES.filter((f) => f.req);
const OPTIONAL = FEATURES.filter((f) => !f.req);

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
  extraValues,
  extraError,
  overriding,
  jump,
  onChange,
  onExtraChange,
}: {
  features: Record<string, FeatureState>;
  scopeLabel: string;
  extraValues: string;
  extraError: string | null;
  /** Features whose value differs from base — marked with the same dot the namespace tile carries. */
  overriding?: Set<string>;
  /** A feature to open and scroll to, from a press on a microservice card's chip. */
  jump?: { feature: string; n: number };
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
    () => new Set(OPTIONAL.filter((f) => features[f.id]?.on).map((f) => f.cat))
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

  function setField(id: string, key: string, value: unknown) {
    const state = features[id] ?? { on: true, v: defaultValues(id) };
    onChange({ ...features, [id]: { ...state, on: true, v: { ...state.v, [key]: value } } });
  }

  return (
    <div className="ag-features">
      <section className="ag-category" aria-label="Required">
        <h4 className="ag-category-name ag-required-head">Required</h4>
        {REQUIRED.map((spec) => (
          <div className="ag-feature on ag-feature-required" key={spec.id} data-feature-card={spec.id}>
            <div className="ag-feature-head">
              <span className="ag-feature-name">{spec.name}</span>
              <FeatureHelp spec={spec} />
              {overriding?.has(spec.id) && (
                <OverrideLight name={spec.name} onRemove={() => removeOverride(spec.id)} />
              )}
            </div>
            <FeatureBody spec={spec} state={features[spec.id]} onField={setField} />
          </div>
        ))}
      </section>

      {CATEGORIES.map((cat) => {
        const specs = OPTIONAL.filter((f) => f.cat === cat.id);
        if (!specs.length) return null;
        const count = specs.filter((spec) => features[spec.id]?.on).length;
        const shown = open.has(cat.id);
        return (
          <section className="ag-category" key={cat.id} aria-label={cat.name}>
            <button type="button" className="ag-category-head" aria-expanded={shown} onClick={() => toggleCategory(cat.id)}>
              {shown ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              <span className="ag-category-name">{cat.name}</span>
              {count > 0 && <span className="ag-category-count">{count} on</span>}
              {/* So a collapsed category still says it holds an override. */}
              {specs.some((spec) => overriding?.has(spec.id)) && (
                <i className="ag-dot" title="Holds an override of the base file" />
              )}
            </button>
            {shown && specs.map((spec) => {
              const state = features[spec.id];
              const on = !!state?.on;
              return (
                <div className={`ag-feature${on ? " on" : ""}`} key={spec.id} data-feature-card={spec.id}>
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
                  {on && <FeatureBody spec={spec} state={state} onField={setField} />}
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
    <Help label={`the override on ${name}`} interactive trigger={<i className="ag-dot" aria-hidden="true" />}>
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
  onField,
}: {
  spec: FeatureSpec;
  state: FeatureState | undefined;
  onField: (id: string, key: string, value: unknown) => void;
}) {
  // Local, and keyed by field: pressing "add" is a request to see the field,
  // not a value, so it must not be written into the document.
  const [added, setAdded] = useState<Set<string>>(new Set());
  const primary = new Set(primaryFields(spec).map((f) => f.key));
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
  const rest = spec.fields.filter((f) => !isShown(f) && f.key !== "enabled");

  return (
    <div className="ag-feature-body">
      {spec.fields.filter(isShown).map((field) => (
        <FeatureField
          key={field.key}
          spec={field}
          value={state?.v?.[field.key]}
          onChange={(value) => onField(spec.id, field.key, value)}
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
