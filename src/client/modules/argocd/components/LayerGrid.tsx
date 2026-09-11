import { Pencil, Plus, X } from "lucide-react";
import { useState } from "react";

/**
 * Which layer the form below is editing: the release's base file, or one
 * namespace's overrides. The same rectangle the releases use, at half the size
 * — a layer has one fact to carry, not a list of objects.
 *
 * A namespace tile counts the releases that override in it, and marks the one
 * currently open, so where *this* release is customised is visible without
 * clicking through every namespace to find out.
 */
export type LayerCard = {
  name: string;
  /** How many of the tree's releases have an override file in this namespace. */
  overrides: number;
  /** Whether the release currently open is one of them. */
  overridesSelected: boolean;
};

type Props = {
  /** -1 for the base layer, otherwise the namespace's index. */
  layer: number;
  namespaces: LayerCard[];
  releaseCount: number;
  onSelect: (layer: number) => void;
  onRename: (index: number, name: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
};

const BASE = -1;

export function LayerGrid({ layer, namespaces, releaseCount, onSelect, onRename, onRemove, onAdd }: Props) {
  /** Which tile's name is being typed into. Local — nothing above needs to know. */
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <div className="ag-card-grid ag-layer-grid" aria-label="Layers">
      <button
        type="button"
        aria-pressed={layer === BASE}
        className={`ag-card ag-layer-card${layer === BASE ? " selected" : ""}`}
        onClick={() => onSelect(BASE)}
      >
        <span className="ag-card-name">Base</span>
        <span className="ag-card-foot">every namespace</span>
      </button>

      {namespaces.map((ns, i) => {
        const label = ns.name.trim() || "this namespace";
        const body = (
          <>
            <span className="ag-card-name">
              {editing === i ? (
                <input
                  className="title-edit-input"
                  aria-label="Namespace name"
                  value={ns.name}
                  placeholder="shop-web"
                  autoFocus
                  onChange={(e) => onRename(i, e.target.value)}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(e) => {
                    // Enter and Escape both just leave the field — every keystroke
                    // is already in the draft, and autosave is what writes it.
                    if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                  }}
                />
              ) : (
                ns.name.trim() || "unnamed"
              )}
              {ns.overridesSelected && <i className="ag-dot" title="This release is overridden here" />}
            </span>
            <span className="ag-card-foot">
              {ns.overrides ? `${ns.overrides} of ${releaseCount} overridden` : "no overrides"}
            </span>
          </>
        );
        return (
          // The tools are siblings of the card, not children: the card is itself
          // a <button>, and a button inside a button is invalid HTML that
          // browsers silently un-nest (same reason ReleaseGrid's Chip carries a
          // `data-feature` instead of being one). While the name is being typed
          // the card is a plain div for the same reason — an <input> cannot live
          // inside a <button> either, and the tile being renamed is the selected
          // one anyway, so there is nothing left to press it for.
          <div className="ag-card-shell" key={i}>
            {editing === i ? (
              <div className={`ag-card ag-layer-card${layer === i ? " selected" : ""}`}>{body}</div>
            ) : (
              <button
                type="button"
                aria-pressed={layer === i}
                className={`ag-card ag-layer-card${layer === i ? " selected" : ""}`}
                onClick={() => onSelect(i)}
              >
                {body}
              </button>
            )}
            <span className="ag-card-tools">
              <button
                type="button"
                className="icon-button"
                aria-label={`Rename ${label}`}
                // Selected as well as renamed: the fields underneath are what
                // the name is about, and renaming a tile you cannot see the
                // contents of is how the wrong one gets renamed.
                onClick={() => {
                  onSelect(i);
                  setEditing(i);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${label}`}
                onClick={() => onRemove(i)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          </div>
        );
      })}

      <button type="button" className="ag-card ag-add-card" onClick={onAdd}>
        <Plus size={15} aria-hidden="true" /> Namespace
      </button>
    </div>
  );
}
