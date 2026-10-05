import { Check, Palette } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACCENTS, ROLE, THEMES, applyTheme, cssColor, loadChoice, saveChoice, type ThemeChoice } from "./theme";

// The header's theme menu. Every swatch is drawn with the colours that choice
// would actually paint — a theme row previews its page, panel, text and accent
// under the current accent, and an accent dot is that accent under the current
// theme — so the menu shows the result rather than a name for it.
export function ThemePicker() {
  const [choice, setChoice] = useState<ThemeChoice>(loadChoice);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    saveChoice(next);
    applyTheme(next);
  };

  return (
    <div className="theme-picker" ref={root}>
      <button
        className="ghost-button icon-only"
        aria-label="Theme and colours"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme and colours"
        onClick={() => setOpen((o) => !o)}
      >
        <Palette size={17} aria-hidden="true" />
        <span className="theme-current" style={{ background: cssColor(ROLE.accent, choice) }} />
      </button>

      {open && (
        <div className="theme-menu" role="menu">
          <div className="theme-menu-heading">Theme</div>
          {THEMES.map((t) => {
            const c = { ...choice, theme: t.id };
            const selected = t.id === choice.theme;
            return (
              <button
                key={t.id}
                role="menuitemradio"
                aria-checked={selected}
                className={`theme-row${selected ? " selected" : ""}`}
                onClick={() => pick(c)}
              >
                <span
                  className="theme-preview"
                  style={{ background: cssColor(ROLE.page, c), borderColor: cssColor(ROLE.border, c) }}
                  aria-hidden="true"
                >
                  <span className="theme-preview-panel" style={{ background: cssColor(ROLE.panel, c), color: cssColor(ROLE.text, c) }}>
                    Aa
                  </span>
                  <span className="theme-preview-accent" style={{ background: cssColor(ROLE.accent, c) }} />
                </span>
                <span className="theme-row-label">{t.label}</span>
                {selected && <Check size={15} aria-hidden="true" />}
              </button>
            );
          })}

          <div className="theme-menu-heading">Accent</div>
          <div className="theme-accents">
            {ACCENTS.map((a) => {
              const c = { ...choice, accent: a.id };
              const selected = a.id === choice.accent;
              return (
                <button
                  key={a.id}
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={a.label}
                  title={a.label}
                  className={`theme-accent${selected ? " selected" : ""}`}
                  onClick={() => pick(c)}
                >
                  <span className="theme-accent-dot" style={{ background: cssColor(ROLE.accent, c), color: cssColor(ROLE.onAccent, c) }}>
                    {selected && <Check size={13} aria-hidden="true" />}
                  </span>
                  <span className="theme-accent-label">{a.label}</span>
                </button>
              );
            })}
            {/* The last circle is a native colour input: the dot is a rainbow
                until a colour is picked, then that colour as it paints. */}
            <label
              role="menuitemradio"
              aria-checked={choice.accent === "custom"}
              title="Custom colour"
              className={`theme-accent${choice.accent === "custom" ? " selected" : ""}`}
            >
              <span
                className="theme-accent-dot theme-accent-custom"
                style={
                  choice.accent === "custom"
                    ? { background: cssColor(ROLE.accent, choice), color: cssColor(ROLE.onAccent, choice) }
                    : undefined
                }
              >
                {choice.accent === "custom" && <Check size={13} aria-hidden="true" />}
                <input
                  type="color"
                  aria-label="Custom colour"
                  value={`#${choice.custom ?? "e05560"}`}
                  onClick={() => choice.accent !== "custom" && pick({ ...choice, accent: "custom" })}
                  onChange={(e) => pick({ ...choice, accent: "custom", custom: e.target.value.slice(1) })}
                />
              </span>
              <span className="theme-accent-label">Custom</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
