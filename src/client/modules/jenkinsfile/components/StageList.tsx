import { ChevronsDownUp, ChevronsUpDown, Columns2, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Help } from "../../../Help";
import { SINGLETON_STEPS, STEPS } from "../catalog";
import { moveStage, pairsOf, stageId } from "../pipeline";
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
  /** `group` puts the new stage at the end of that parallel box, a new id opens a new box. */
  onAdd: (step: string, group?: string) => void;
  onRemove: (id: string) => void;
};

/** Where a dragged card lands: an insertion index (0..length), and the box it joins, if any. */
type Drop = { index: number; group?: string };

const NEW = "+new";

/** A run of the list as drawn: one card on its own, or a parallel box of them. */
type Segment = { group?: string; items: { stage: JenkinsfileStage; index: number }[] };

/** populateEnvVars never races — it sets the env everything after it reads. */
const groupOf = (stage: JenkinsfileStage) => (stage.step === "populateEnvVars" ? undefined : stage.group);

function withGroup(stage: JenkinsfileStage, group: string | undefined): JenkinsfileStage {
  const { group: _old, ...rest } = stage;
  return group && stage.step !== "populateEnvVars" ? { ...rest, group } : rest;
}

/**
 * The pipeline as an ordered, drag-reorderable column of cards — the same list
 * you reorder is the one you edit, so there is no rail-and-panel split to keep
 * in sync and the order on screen is the order in the file.
 *
 * A parallel block is a box in that column: the cards inside it run at once,
 * one branch each. It is still one flat list underneath — consecutive stages
 * sharing a `group` — so reordering stays three handlers over an array; a drop
 * just also says which box, if any, the card now belongs to. Dropping on a card
 * inside a box joins it, anywhere else leaves it.
 *
 * Native HTML5 drag and drop, no library. Dragging is bound to the card, not
 * the grip, so a card is only draggable while collapsed: a text input inside an
 * expanded card cannot be selected with the mouse if its ancestor is grabbing
 * the drag.
 *
 * The step palette is a popover that opens upwards, right-aligned with the
 * button that opened it: a panel that pushed the page down would move the
 * button out from under the cursor the moment it opened.
 */
export function StageList({ stages, errors, onToggle, onCollapseAll, onReorder, onChange, onLeave, onAdd, onRemove }: Props) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  /** Which palette is open: the list's own (`""`), a new box's (`NEW`), or a box's by its group. */
  const [palette, setPalette] = useState<string | null>(null);
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

  const segments: Segment[] = [];
  stages.forEach((stage, index) => {
    const group = groupOf(stage);
    const last = segments[segments.length - 1];
    if (group && last?.group === group) last.items.push({ stage, index });
    else segments.push({ group, items: [{ stage, index }] });
  });

  const used = new Set(stages.map((s) => s.step));
  const available = STEPS.filter((s) => !SINGLETON_STEPS.includes(s.step) || !used.has(s.step));
  const allCollapsed = stages.length > 0 && stages.every((s) => s.collapsed);

  // A popover that only closed on its own button would sit over whatever you
  // clicked next.
  useEffect(() => {
    if (palette === null) return;
    function onDown(e: PointerEvent) {
      if (!adder.current?.contains(e.target as Node)) setPalette(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPalette(null);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [palette]);

  function handleDrop() {
    if (dragIndex === null || drop === null) return;
    const moving = stages[dragIndex];
    const moved = moveStage(stages, dragIndex, drop.index > dragIndex ? drop.index - 1 : drop.index);
    onReorder(moved.map((s) => (s.id === moving.id ? withGroup(s, drop.group) : s)));
    setDragIndex(null);
    setDrop(null);
  }

  function ungroup(group: string) {
    onReorder(stages.map((s) => (s.group === group ? withGroup(s, undefined) : s)));
  }

  /** The Add button and its palette. `key` is `""` for the list's own, `NEW`, or the box it adds into. */
  function adderFor(key: string, button: React.ReactNode) {
    const open = palette === key;
    const steps = key ? available.filter((s) => s.step !== "populateEnvVars") : available;
    // A new box gets its id when its first stage is picked.
    const target = key === NEW ? `g-${stageId()}` : key || undefined;
    return (
      <div className="jf-adder" ref={open ? adder : undefined}>
        {button}
        {/* Plain buttons, not role="menu": that role promises arrow-key
            navigation between the items, which this does not implement. */}
        {open && (
          <div className="jf-palette" aria-label="Steps">
            {steps.map((step) => (
              <button
                key={step.step}
                type="button"
                className="jf-add-stage"
                // The visible text is two lines (label + `vars/` file name); the
                // label alone is the useful accessible name.
                aria-label={`Add ${step.label}`}
                title={step.description}
                onClick={() => {
                  onAdd(step.step, target);
                  setPalette(null);
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
    );
  }

  function card(stage: JenkinsfileStage, i: number, segment: Segment, last: boolean) {
    const open = !stage.collapsed;
    const here = (index: number) => drop?.index === index && drop.group === segment.group;
    return (
      <StageCard
        key={stage.id}
        stage={stage}
        index={i}
        errors={errors[stage.id] ?? []}
        stashNames={stashesBefore[i]}
        open={open}
        className={[dragIndex === i ? "dragging" : "", here(i) ? "drop-before" : "", last && here(i + 1) ? "drop-after" : ""]
          .filter(Boolean)
          .join(" ")}
        draggable={!open}
        onDragStart={(e) => {
          e.stopPropagation();
          setDragIndex(i);
          e.dataTransfer.effectAllowed = "move";
          // Firefox ignores a drag that sets no data at all.
          e.dataTransfer.setData("text/plain", stage.id);
        }}
        onDragEnd={() => {
          setDragIndex(null);
          setDrop(null);
        }}
        onDragOver={(e) => {
          if (dragIndex === null) return;
          e.preventDefault();
          e.stopPropagation();
          const box = e.currentTarget.getBoundingClientRect();
          setDrop({ index: e.clientY < box.top + box.height / 2 ? i : i + 1, group: segment.group });
        }}
        onToggle={() => onToggle(stage.id)}
        onChange={onChange}
        onLeave={() => onLeave(stage.id)}
        onRemove={() => onRemove(stage.id)}
      />
    );
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
            {allCollapsed ? <ChevronsUpDown size={16} aria-hidden="true" /> : <ChevronsDownUp size={16} aria-hidden="true" />}
            {allCollapsed ? "Expand all" : "Collapse all"}
          </button>
        )}
      </div>

      {stages.length === 0 ? (
        <p className="jf-empty jf-rail-empty">
          Nothing here yet. Add a stage below — they run top to bottom, and you can drag the collapsed cards to reorder
          them, or into a parallel block to run them at once.
        </p>
      ) : (
        <ol className="jf-cards" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
          {segments.map((segment) => {
            if (!segment.group) return card(segment.items[0].stage, segment.items[0].index, segment, true);
            const group = segment.group;
            const end = segment.items[segment.items.length - 1].index + 1;
            return (
              <li
                key={group}
                className={`jf-parallel-box${drop?.group === group ? " drop-into" : ""}`}
                aria-label="Parallel block"
                // Anywhere in the box that is not a card lands at its end.
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  setDrop({ index: end, group });
                }}
              >
                <div className="jf-parallel-head">
                  <Columns2 size={14} aria-hidden="true" /> Parallel · {segment.items.length} branch
                  {segment.items.length === 1 ? "" : "es"}
                  <Help label="a parallel block">
                    <p>
                      Every stage in this box runs at the same time, each as one branch of a{" "}
                      <code>parallel(…)</code> block named by its title. The next stage below waits for all of them.
                    </p>
                    <p>Drag a collapsed stage onto a card in here to add it; drag it out to run it on its own.</p>
                  </Help>
                  <button type="button" className="ghost-button" onClick={() => ungroup(group)}>
                    Ungroup
                  </button>
                </div>
                <ol className="jf-cards">
                  {segment.items.map(({ stage, index }, n) => card(stage, index, segment, n === segment.items.length - 1))}
                </ol>
                {adderFor(
                  group,
                  <button type="button" className="ghost-button" aria-expanded={palette === group} onClick={() => setPalette(palette === group ? null : group)}>
                    <Plus size={15} aria-hidden="true" /> Add branch
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="jf-adders">
        {adderFor(
          NEW,
          <button type="button" className="ghost-button" aria-expanded={palette === NEW} onClick={() => setPalette(palette === NEW ? null : NEW)}>
            <Columns2 size={16} aria-hidden="true" /> Add parallel block
          </button>
        )}
        {adderFor(
          "",
          <button type="button" className="primary jf-add-stage-button" aria-expanded={palette === ""} onClick={() => setPalette(palette === "" ? null : "")}>
            <Plus size={16} aria-hidden="true" /> Add stage
          </button>
        )}
      </div>
    </div>
  );
}
