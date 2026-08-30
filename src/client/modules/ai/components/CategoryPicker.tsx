import { HelpCircle, X } from "lucide-react";
import type { AiCategory } from "../../../../server/types";

export function CategoryPicker({
  categories,
  onPick,
  onClose,
}: {
  categories: AiCategory[];
  onPick: (name: string | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="pick-category-title">
        <div className="modal-heading">
          <h2 id="pick-category-title">What is this chat about?</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="chat-category-list">
          {categories.length === 0 && (
            <p className="field-hint">
              No repos registered — add a <code>ai-*</code> skill under{" "}
              <code>~/.claude/skills/</code>.
            </p>
          )}
          {categories.map((c) => (
            <button key={c.name} className="chat-category-item" onClick={() => onPick(c.name)}>
              <span className="chat-category-name">{c.name}</span>
              {c.description && <span className="chat-category-description">{c.description}</span>}
            </button>
          ))}
          {categories.length > 1 && (
            <button className="chat-category-item chat-category-unsure" onClick={() => onPick(null)}>
              <span className="chat-category-name">
                <HelpCircle size={14} aria-hidden="true" />
                I'm not sure
              </span>
              <span className="chat-category-description">
                Ask your question first — it'll figure out which repo fits from the list above.
              </span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
