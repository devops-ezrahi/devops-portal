import { Plus } from "lucide-react";

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
  onAdd: () => void;
};

const BASE = -1;

export function LayerGrid({ layer, namespaces, releaseCount, onSelect, onAdd }: Props) {
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

      {namespaces.map((ns, i) => (
        <button
          key={i}
          type="button"
          aria-pressed={layer === i}
          className={`ag-card ag-layer-card${layer === i ? " selected" : ""}`}
          onClick={() => onSelect(i)}
        >
          <span className="ag-card-name">
            {ns.name.trim() || "unnamed"}
            {ns.overridesSelected && <i className="ag-dot" title="This release is overridden here" />}
          </span>
          <span className="ag-card-foot">
            {ns.overrides ? `${ns.overrides} of ${releaseCount} overridden` : "no overrides"}
          </span>
        </button>
      ))}

      <button type="button" className="ag-card ag-add-card" onClick={onAdd}>
        <Plus size={15} aria-hidden="true" /> Namespace
      </button>
    </div>
  );
}
