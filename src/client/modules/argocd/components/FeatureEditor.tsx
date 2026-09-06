import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { CATEGORIES, FEATURES, defaultValues } from "../catalog";
import { FeatureField } from "./FeatureField";
import type { FeatureState } from "../catalog";

/**
 * Every chart feature is on screen, always, in catalog order — the ones in use
 * expanded, the rest as one-line rows you tick to add, so switching one on
 * expands it in place rather than reshuffling the list. Same rule the
 * Jenkinsfile builder follows for a step's arguments.
 */
export function FeatureEditor({
  features,
  scopeLabel,
  extraValues,
  extraError,
  onChange,
  onExtraChange,
}: {
  features: Record<string, FeatureState>;
  scopeLabel: string;
  extraValues: string;
  extraError: string | null;
  onChange: (features: Record<string, FeatureState>) => void;
  onExtraChange: (text: string) => void;
}) {
  /**
   * A category opens when it holds something, so a namespace override lands on
   * the two sections it actually uses rather than on forty-five collapsed ones
   * — and the generated files stay within reach of the form. Core is open on a
   * release nothing is set on yet, because that is where you start.
   */
  const [open, setOpen] = useState<Set<string>>(() => {
    const used = new Set(FEATURES.filter((f) => features[f.id]?.on).map((f) => f.cat));
    return used.size ? used : new Set(["core"]);
  });

  function toggleCategory(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function toggle(id: string, on: boolean) {
    const existing = features[id];
    onChange({ ...features, [id]: { on, v: existing?.v ?? defaultValues(id) } });
  }

  function setField(id: string, key: string, value: unknown) {
    const state = features[id] ?? { on: true, v: defaultValues(id) };
    onChange({ ...features, [id]: { ...state, on: true, v: { ...state.v, [key]: value } } });
  }

  return (
    <div className="ag-features">
      {CATEGORIES.map((cat) => {
        const specs = FEATURES.filter((f) => f.cat === cat.id);
        if (!specs.length) return null;
        const count = specs.filter((spec) => features[spec.id]?.on).length;
        const shown = open.has(cat.id);
        return (
          <section className="ag-category" key={cat.id} aria-label={cat.name}>
            <button type="button" className="ag-category-head" aria-expanded={shown} onClick={() => toggleCategory(cat.id)}>
              {shown ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
              <span className="ag-category-name">{cat.name}</span>
              {count > 0 && <span className="ag-category-count">{count} on</span>}
            </button>
            {shown && specs.map((spec) => {
              const state = features[spec.id];
              const on = !!state?.on;
              return (
                <div className={`ag-feature${on ? " on" : ""}`} key={spec.id}>
                  <label className="ag-feature-head">
                    <input type="checkbox" checked={on} onChange={(e) => toggle(spec.id, e.target.checked)} />
                    <span className="ag-feature-name">{spec.name}</span>
                    <span className="ag-feature-blurb">{spec.blurb}</span>
                  </label>
                  {on && (
                    <div className="ag-feature-body">
                      {spec.fields.map((field) => (
                        <FeatureField
                          key={field.key}
                          spec={field}
                          value={state?.v?.[field.key]}
                          onChange={(value) => setField(spec.id, field.key, value)}
                        />
                      ))}
                      {spec.notes?.map((note) => (
                        <p className="ag-note" key={note}>
                          {note}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}

      <section className="ag-category" aria-label="Extra values">
        <h4 className="ag-category-name">Extra values</h4>
        {/* The escape hatch, and where an import's unrecognised keys land. It is
            merged last and wins, so anything the catalog cannot model still
            reaches the file. */}
        <p className="ag-feature-blurb">Raw YAML merged into {scopeLabel}, last and winning.</p>
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
