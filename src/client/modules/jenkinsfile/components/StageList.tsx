import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SINGLETON_STEPS, STEPS } from "../catalog";
import { moveStage, pairsOf } from "../pipeline";
import { StageCard } from "./StageCard";
import type { JenkinsfileStage } from "../../../../server/types";

type Props = {
  stages: JenkinsfileStage[];
  errors: Record<string, string[]>;
  onToggle: (id: string) => void;
  onCollapseAll: (collapsed: boolean) => void;
  onReorder: (stages: JenkinsfileStage[]) => void;
  onChange: (stage: JenkinsfileStage) => void;
  onLeave: (id: string) => void;
  onAdd: (step: string) => void;
  onRemove: (id: string) => void;
};

/**
 * The pipeline as an ordered, drag-reorderable column of cards — the same list
 * you reorder is the one you edit, so there is no rail-and-panel split to keep
 * in sync and the order on screen is the order in the file.
 *
 * Native HTML5 drag and drop, no library: the whole interaction is three
 * handlers over an array. `dropIndex` is an *insertion* index (0..length), which
 * is why the drop converts it — dropping below the dragged card means the card
 * ahead of it has already shifted up by one. Dragging is bound to the card, not
 * the grip, so a card is only draggable while collapsed: a text input inside an
 * expanded card cannot be selected with the mouse if its ancestor is grabbing
 * the drag.
 *
 * Adding a stage is the last thing in the list, and its palette is a popover
 * that opens upwards, right-aligned with the button:
 * a panel that pushed the page down would move the button out from under the
 * cursor the moment it opened.
 */
export function StageList({
  stages,
  errors,
  onToggle,
  onCollapseAll,
  onReorder,
  onChange,
  onLeave,
  onAdd,
  onRemove,
}: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const adder = useRef<HTMLDivElement>(null);

  /**
   * What each stage may unstash: every name stashed *before* it. Same-stage
   * stashes are excluded because the library stashes after the commands run, so
   * a stage cannot unstash what it has not written yet.
   */
  const stashesBefore: string[][] = [];
  const seen: string[] = [];
  for (const stage of stages) {
    stashesBefore.push([...seen]);
    for (const [name] of pairsOf(stage.args.stash)) {
      if (name.trim() && !seen.includes(name.trim())) seen.push(name.trim());
    }
  }

  const used = new Set(stages.map((s) => s.step));
  const available = STEPS.filter((s) => !SINGLETON_STEPS.includes(s.step) || !used.has(s.step));
  const allCollapsed = stages.length > 0 && stages.every((s) => s.collapsed);

  // A popover that only closed on its own button would sit over whatever you
  // clicked next.
  useEffect(() => {
    if (!paletteOpen) return;
    function onDown(e: PointerEvent) {
      if (!adder.current?.contains(e.target as Node)) setPaletteOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPaletteOpen(false);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen]);

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
    <div className="jf-stage-list">
      <div className="jf-list-head">
        <h2>Stages</h2>
        <span className="jf-group-count">
          {stages.length} step{stages.length === 1 ? "" : "s"}
        </span>
        {stages.length > 0 && (
          <button type="button" className="ghost-button jf-head-action" onClick={() => onCollapseAll(!allCollapsed)}>
            {allCollapsed ? (
              <ChevronsUpDown size={16} aria-hidden="true" />
            ) : (
              <ChevronsDownUp size={16} aria-hidden="true" />
            )}
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>

      {stages.length === 0 ? (
        <p className="jf-empty jf-rail-empty">
          Nothing here yet. Add a stage below — they run top to bottom, and you can drag the collapsed
          cards to reorder them.
        </p>
      ) : (
        <ol className="jf-cards" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
          {stages.map((stage, i) => {
            const open = !stage.collapsed;
            return (
              <StageCard
                key={stage.id}
                stage={stage}
                index={i}
                errors={errors[stage.id] ?? []}
                stashNames={stashesBefore[i]}
                open={open}
                className={[
                  dragIndex === i ? "dragging" : "",
                  dropIndex === i ? "drop-before" : "",
                  dropIndex === stages.length && i === stages.length - 1 ? "drop-after" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                draggable={!open}
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
                  if (dragIndex === null) return;
                  e.preventDefault();
                  const box = e.currentTarget.getBoundingClientRect();
                  setDropIndex(e.clientY < box.top + box.height / 2 ? i : i + 1);
                }}
                onToggle={() => onToggle(stage.id)}
                onChange={onChange}
                onLeave={() => onLeave(stage.id)}
                onRemove={() => onRemove(stage.id)}
              />
            );
          })}
        </ol>
      )}

      <div className="jf-adder" ref={adder}>
        <button
          type="button"
          className="primary jf-add-stage-button"
          aria-expanded={paletteOpen}
          onClick={() => setPaletteOpen((v) => !v)}
        >
          <Plus size={16} aria-hidden="true" /> Add stage
        </button>

        {/* Plain buttons, not role="menu": that role promises arrow-key
            navigation between the items, which this does not implement. */}
        {paletteOpen && (
          <div className="jf-palette" aria-label="Steps">
            {available.map((step) => (
              <button
                key={step.step}
                type="button"
                className="jf-add-stage"
                // The visible text is two lines (label + `vars/` file name); the
                // label alone is the useful accessible name.
                aria-label={`Add ${step.label}`}
                title={step.description}
                onClick={() => {
                  onAdd(step.step);
                  setPaletteOpen(false);
                }}
              >
                <Plus size={14} aria-hidden="true" />
                <span className="jf-add-stage-text">
                  <strong>{step.label}</strong>
                  <small>{step.step}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
