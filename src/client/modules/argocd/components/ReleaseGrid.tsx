import { Plus } from "lucide-react";
import { SCOPE_NOTE, type Resource } from "../resources";

/**
 * One rectangle per release — the microservices this tree deploys — and what
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
  onAdd: () => void;
};

/** `ConfigMap ×2`, with the objects' own names and what kind of thing it is on hover. */
function Chip({ kind, names, variant, title }: { kind: string; names?: string[]; variant?: string; title?: string }) {
  return (
    <span className={`ag-chip${variant ? ` ${variant}` : ""}`} title={title ?? names?.join(", ")}>
      {kind}
      {names && names.length > 1 && <b> ×{names.length}</b>}
    </span>
  );
}

/** `ConfigMap ×2 — app-config, feature-flags · An object of its own…` */
const chipTitle = (r: Resource) => [r.names?.join(", "), SCOPE_NOTE[r.scope]].filter(Boolean).join(" · ");

export function ReleaseGrid({ cards, selectedId, onSelect, onAdd }: Props) {
  return (
    <div className="ag-card-grid" aria-label="Releases">
      {cards.map((card) => {
        // Grouped by what each thing *is*, not just listed: the workload, the
        // parts of its pod template, the objects beside it, and the
        // cluster-scoped ones that only one release may own. `resourcesOf`
        // returns them already in that order.
        const workload = card.resources.find((r) => r.scope === "workload");
        const rest = card.resources.filter((r) => r.scope !== "workload");
        const selected = card.id === selectedId;
        return (
          <button
            key={card.id}
            type="button"
            aria-pressed={selected}
            className={`ag-card ag-release-card${selected ? " selected" : ""}`}
            onClick={() => onSelect(card.id)}
          >
            <span className="ag-card-name">{card.name.trim() || "unnamed"}</span>
            {/* "no image" is a nudge for a release that runs pods and has not
                been given one yet — `checks.ts` refuses that outright. A release
                with no workload is not missing anything. */}
            {(card.image || workload) && <span className="ag-card-image">{card.image || "no image"}</span>}
            <span className="ag-card-chips">
              {workload && <Chip kind={workload.kind} variant="workload" title={SCOPE_NOTE.workload} />}
              {rest.map((r) => (
                <Chip key={r.kind} kind={r.kind} names={r.names} variant={r.scope} title={chipTitle(r)} />
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
          </button>
        );
      })}

      <button type="button" className="ag-card ag-add-card" onClick={onAdd}>
        <Plus size={15} aria-hidden="true" /> Release
      </button>
    </div>
  );
}
