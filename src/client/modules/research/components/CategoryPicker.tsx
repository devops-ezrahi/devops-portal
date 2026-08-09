import { X } from "lucide-react";
import type { ResearchCategory } from "../../../../server/types";

export function CategoryPicker({
  categories,
  onPick,
  onClose,
}: {
  categories: ResearchCategory[];
  onPick: (name: string) => void;
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
            <p style={{ margin: 0, fontSize: 13 }}>
              No repos registered — add a <code>research-*</code> skill under{" "}
              <code>~/.claude/skills/</code>.
            </p>
          )}
          {categories.map((c) => (
            <button key={c.name} className="chat-category-item" onClick={() => onPick(c.name)}>
              <span className="chat-category-name">{c.name}</span>
              {c.description && <span className="chat-category-description">{c.description}</span>}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
