import { Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { SCOPE_NOTE, type Resource } from "../resources";

/**
 * One rectangle per microservice — a release of the universal chart — and what
 * each of them puts in the cluster.
 *
 * It replaced a strip of name-only pills. A release is a Deployment *and* the
 * Service, Route and ConfigMaps around it, and none of that was visible without
 * selecting the release and opening the catalog. Pressing a card still only
 * selects: the editor for whatever is selected renders underneath, as before.
 */
export type ReleaseCard = {
  id: string;
  name: string;
  /** `repo:tag`, or empty when no image is set yet. */
  image: string;
  /** What the base file creates. */
  resources: Resource[];
  /** Kinds only a namespace override adds — drawn dashed, hovering as the namespaces that add them. */
  extras: { kind: string; namespaces: string[] }[];
  /** How many namespaces override this release, out of how many there are. */
  overrides: { count: number; total: number };
};

type Props = {
  cards: ReleaseCard[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** Pressing a chip selects the card *and* jumps to the fields that set it. */
  onJump: (releaseId: string, feature: string) => void;
  onRename: (releaseId: string, name: string) => void;
  onRemove: (releaseId: string) => void;
  onAdd: () => void;
};

/** `ConfigMap ×2`, with the objects' own names and what kind of thing it is on hover. */
function Chip({
  kind,
  names,
  variant,
  title,
  feature,
}: {
  kind: string;
  names?: string[];
  variant?: string;
  title?: string;
  feature?: string;
}) {
  return (
    // `data-feature` rather than a nested <button>: the whole card is already a
    // button, and a button inside a button is invalid HTML that browsers
    // silently un-nest. The card's own click handler reads this off the target.
    <span
      className={`ag-chip${variant ? ` ${variant}` : ""}${feature ? " linked" : ""}`}
      data-feature={feature}
      title={title ?? names?.join(", ")}
    >
      {kind}
      {names && names.length > 1 && <b> ×{names.length}</b>}
    </span>
  );
}

/** `ConfigMap ×2 — app-config, feature-flags · An object of its own…` */
const chipTitle = (r: Resource) => [r.names?.join(", "), SCOPE_NOTE[r.scope]].filter(Boolean).join(" · ");

export function ReleaseGrid({ cards, selectedId, onSelect, onJump, onRename, onRemove, onAdd }: Props) {
  /** Which card's name is being typed into. Local — nothing above needs to know. */
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="ag-card-grid" aria-label="Microservices">
      {cards.map((card) => {
        // Grouped by what each thing *is*, not just listed: the workload, the
        // parts of its pod template, the objects beside it, and the
        // cluster-scoped ones that only one release may own. `resourcesOf`
        // returns them already in that order.
        const workload = card.resources.find((r) => r.scope === "workload");
        const rest = card.resources.filter((r) => r.scope !== "workload");
        const selected = card.id === selectedId;
        const label = card.name.trim() || "this microservice";
        const body = (
          <>
            <span className="ag-card-name">
              {editing === card.id ? (
                <input
                  className="title-edit-input"
                  aria-label="Microservice name"
                  value={card.name}
                  placeholder="api-gateway"
                  autoFocus
                  onChange={(e) => onRename(card.id, e.target.value)}
                  onBlur={() => setEditing(null)}
                  onKeyDown={(e) => {
                    // Enter and Escape both just leave the field — every keystroke
                    // is already in the draft, and autosave is what writes it.
                    if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
                  }}
                />
              ) : (
                card.name.trim() || "unnamed"
              )}
            </span>
            {/* "no image" is a nudge for a release that runs pods and has not
                been given one yet — `checks.ts` refuses that outright. A release
                with no workload is not missing anything. */}
            {(card.image || workload) && <span className="ag-card-image">{card.image || "no image"}</span>}
            <span className="ag-card-chips">
              {workload && (
                <Chip kind={workload.kind} variant="workload" feature={workload.feature} title={SCOPE_NOTE.workload} />
              )}
              {rest.map((r) => (
                <Chip
                  key={r.kind}
                  kind={r.kind}
                  names={r.names}
                  variant={r.scope}
                  feature={r.feature}
                  title={chipTitle(r)}
                />
              ))}
              {card.extras.map((e) => (
                <Chip
                  key={e.kind}
                  kind={e.kind}
                  variant="added"
                  title={`Added by ${e.namespaces.join(", ")} — not in the base file`}
                />
              ))}
            </span>
            {card.overrides.count > 0 && (
              <span className="ag-card-foot">
                overridden in {card.overrides.count} of {card.overrides.total} namespaces
              </span>
            )}
          </>
        );
        return (
          // The pencil and the × are siblings of the card rather than children,
          // for the reason `Chip` above documents: the card is a <button>, and a
          // button inside a button is invalid HTML. An <input> cannot live in
          // one either, so the card being renamed is a plain div — it is the
          // selected one anyway, so there is nothing left to press it for.
          <div className="ag-card-shell" key={card.id}>
            {editing === card.id ? (
              <div className={`ag-card ag-release-card${selected ? " selected" : ""}`}>{body}</div>
            ) : (
              <button
                type="button"
                aria-pressed={selected}
                className={`ag-card ag-release-card${selected ? " selected" : ""}`}
                onClick={(e) => {
                  const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-feature]");
                  if (chip?.dataset.feature) onJump(card.id, chip.dataset.feature);
                  else onSelect(card.id);
                }}
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
                // the name is about, and renaming a card you cannot see the
                // contents of is how the wrong one gets renamed.
                onClick={() => {
                  onSelect(card.id);
                  setEditing(card.id);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${label}`}
                onClick={() => onRemove(card.id)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          </div>
        );
      })}

      <button type="button" className="ag-card ag-add-card" onClick={onAdd}>
        <Plus size={15} aria-hidden="true" /> Microservice
      </button>
    </div>
  );
}
