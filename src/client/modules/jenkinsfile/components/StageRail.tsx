import { AlertTriangle, ChevronDown, ChevronRight, ChevronUp, GripVertical, Plus, X } from "lucide-react";
import { useState } from "react";
import { STEPS } from "../catalog";
import { moveStage, stageLabel } from "../pipeline";
import type { JenkinsfileStage } from "../../../../server/types";

type Props = {
  stages: JenkinsfileStage[];
  selectedId: string | null;
  errors: Record<string, string[]>;
  onSelect: (id: string) => void;
  onReorder: (stages: JenkinsfileStage[]) => void;
  onAdd: (step: string) => void;
  onRemove: (id: string) => void;
};

/**
 * The pipeline as an ordered, drag-reorderable list.
 *
 * Native HTML5 drag and drop, no library: the whole interaction is three
 * handlers over an array. `dropIndex` is an *insertion* index (0..length), which
 * is why the drop converts it — dropping below the dragged card means the card
 * ahead of it has already shifted up by one.
 *
 * The ▲/▼ buttons are not decoration: dragging is mouse-only, so they are the
 * keyboard path, and they are also what makes reordering testable in jsdom.
 */
export function StageRail({ stages, selectedId, errors, onSelect, onReorder, onAdd, onRemove }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Open by default: on an empty pipeline it is the only thing to do, and on a
  // full one adding another stage is still the common next move.
  const [paletteOpen, setPaletteOpen] = useState(true);

  function move(from: number, to: number) {
    onReorder(moveStage(stages, from, to));
  }

  function handleDrop() {
    if (dragIndex === null || dropIndex === null) return;
    move(dragIndex, dropIndex > dragIndex ? dropIndex - 1 : dropIndex);
    setDragIndex(null);
    setDropIndex(null);
  }

  return (
    <div className="jf-rail">
      <div className="jf-rail-head">
        <h3>Stages</h3>
        <span className="jf-group-count">
          {stages.length} step{stages.length === 1 ? "" : "s"}
        </span>
      </div>

      {stages.length === 0 && (
        <p className="jf-empty jf-rail-empty">
          Nothing here yet. Pick a step below — they run top to bottom, and you can drag the cards to
          reorder them.
        </p>
      )}

      <ol className="jf-stages" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
        {stages.map((stage, i) => {
          const classes = [
            "jf-stage",
            stage.id === selectedId ? "selected" : "",
            dragIndex === i ? "dragging" : "",
            dropIndex === i ? "drop-before" : "",
            dropIndex === stages.length && i === stages.length - 1 ? "drop-after" : "",
            errors[stage.id] ? "has-error" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <li key={stage.id}>
              <div
                className={classes}
                draggable
                role="button"
                tabIndex={0}
                aria-current={stage.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(stage.id)}
                onKeyDown={(e) => {
                  // Alt+arrows move, Enter/Space selects — the same two things
                  // the pointer can do.
                  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                    e.preventDefault();
                    move(i, e.key === "ArrowUp" ? i - 1 : i + 1);
                  } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(stage.id);
                  }
                }}
                onDragStart={(e) => {
                  setDragIndex(i);
                  e.dataTransfer.effectAllowed = "move";
                  // Firefox ignores a drag that sets no data at all.
                  e.dataTransfer.setData("text/plain", stage.id);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setDropIndex(null);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  setDropIndex(e.clientY < box.top + box.height / 2 ? i : i + 1);
                }}
              >
                <GripVertical className="jf-grip" size={16} aria-hidden="true" />
                <span className="jf-stage-index">{i + 1}</span>
                <span className="jf-stage-text">
                  <strong>{stageLabel(stage)}</strong>
                  <small>{stage.step}</small>
                </span>
                {errors[stage.id] && (
                  <AlertTriangle
                    className="jf-stage-warn"
                    size={14}
                    aria-label={`${stageLabel(stage)} has ${errors[stage.id].length} problem(s)`}
                  />
                )}
                <span className="jf-stage-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Move ${stageLabel(stage)} up`}
                    disabled={i === 0}
                    onClick={(e) => {
                      e.stopPropagation();
                      move(i, i - 1);
                    }}
                  >
                    <ChevronUp size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Move ${stageLabel(stage)} down`}
                    disabled={i === stages.length - 1}
                    onClick={(e) => {
                      e.stopPropagation();
                      move(i, i + 1);
                    }}
                  >
                    <ChevronDown size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${stageLabel(stage)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(stage.id);
                    }}
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        className="jf-group-head jf-add-heading"
        aria-expanded={paletteOpen}
        onClick={() => setPaletteOpen((v) => !v)}
      >
        <ChevronRight className={`jf-group-chevron${paletteOpen ? " open" : ""}`} size={14} aria-hidden="true" />
        <span className="jf-group-title">Add a stage</span>
        <span className="jf-group-count">{STEPS.length} steps</span>
      </button>

      <div className="jf-palette" hidden={!paletteOpen}>
        {STEPS.map((step) => (
          <button
            key={step.step}
            type="button"
            className="jf-add-stage"
            // The visible text is two lines (label + `vars/` file name); the
            // label alone is the useful accessible name.
            aria-label={`Add ${step.label}`}
            title={step.description}
            onClick={() => onAdd(step.step)}
          >
            <Plus size={14} aria-hidden="true" />
            <span className="jf-add-stage-text">
              <strong>{step.label}</strong>
              <small>{step.step}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
