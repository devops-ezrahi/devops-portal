import { AlertTriangle, Pencil, Plus, Share2, X } from "lucide-react";
import { useState } from "react";
import { Help } from "../../../Help";
import { featureForPath } from "../catalog";
import { SCOPE_NOTE, type Resource, type Scope } from "../resources";
import { useGridSort, type Sorts } from "./GridSort";

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
  /** `image.repository`, or empty when none is set yet. */
  image: string;
  /**
   * The tag the open layer deploys. `null` = a namespace deploys none, which is
   * worth saying; `undefined` = base sets none, which is normal (tags are
   * usually per-namespace) and shows nothing.
   */
  tag?: string | null;
  /** What the base file creates. */
  resources: Resource[];
  /**
   * Kinds only a namespace override adds — drawn dashed, hovering as the
   * namespaces that add them. `feature` is set only while one of those
   * namespaces is open, which is what makes the chip pressable.
   */
  extras: { kind: string; namespaces: string[]; feature?: string }[];
  /** How many namespaces override this release, out of how many there are. */
  overrides: { count: number; total: number };
  /**
   * Base values here that only an environment can answer — an image tag, a
   * host. `findEnvSpecific` decides; the card just says so.
   */
  envSpecific?: { paths: string[]; namespaces: string[] };
};

type Props = {
  cards: ReleaseCard[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /**
   * Pressing a chip selects the card *and* jumps to the fields that set it.
   * `toBase` is the card's per-namespace warning: it is about base, so that is
   * the layer where the same warning sits on the field.
   */
  onJump: (releaseId: string, feature: string, toBase?: boolean) => void;
  onRename: (releaseId: string, name: string) => void;
  onRemove: (releaseId: string) => void;
  /** Returns the new release's id, so its name field opens immediately. */
  onAdd: () => string | void;
  /** Add the namespace-shared release. Absent once the tree already has one. */
  onAddShared?: () => void;
  /**
   * The selected namespace's defaults — one per namespace, for every
   * microservice in it. Absent in Base, which has none.
   */
  nsDefaults?: { name: string; count: number; open: boolean; onOpen: () => void };
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

/**
 * One row per scope, in the order `resourcesOf` already ranks them, so the
 * shape of the card says what belongs to what: the workload first, the parts of
 * its pod template indented under it, then the objects beside it, then the
 * cluster-scoped ones. On one wrapped line a `Volume` sat beside a `ConfigMap`
 * as though they were the same kind of thing — one is a stanza inside the
 * Deployment and the other is an object with its own lifetime.
 */
const SCOPES: Scope[] = ["workload", "pod", "object", "cluster"];

const SORTS: Sorts<ReleaseCard> = {
  added: { label: "Order added", by: () => 0 },
  name: { label: "Name A–Z", by: (a: ReleaseCard, b: ReleaseCard) => a.name.localeCompare(b.name) },
  nameDesc: { label: "Name Z–A", by: (a: ReleaseCard, b: ReleaseCard) => b.name.localeCompare(a.name) },
  overrides: { label: "Most overridden", by: (a: ReleaseCard, b: ReleaseCard) => b.overrides.count - a.overrides.count },
  warnings: { label: "Warnings first", by: (a: ReleaseCard, b: ReleaseCard) => Number(!!b.envSpecific) - Number(!!a.envSpecific) },
  resources: { label: "Most objects", by: (a: ReleaseCard, b: ReleaseCard) => b.resources.length - a.resources.length },
};

export function ReleaseGrid({
  cards,
  selectedId,
  onSelect,
  onJump,
  onRename,
  onRemove,
  onAdd,
  onAddShared,
  nsDefaults,
}: Props) {
  /** Which card's name is being typed into. Local — nothing above needs to know. */
  const [editing, setEditing] = useState<string | null>(null);
  const { order, control } = useGridSort(SORTS, "argocd.releaseSort");
  const sorted = order(cards);

  return (
    <>
      {/* One per namespace, above the squares rather than among them: it is not
          a microservice, it is what every microservice here starts from. */}
      {nsDefaults && (
        <div className="ag-ns-defaults-shell">
          <button
            type="button"
            aria-pressed={nsDefaults.open}
            className={`ag-ns-defaults${nsDefaults.open ? " selected" : ""}`}
            onClick={nsDefaults.onOpen}
          >
            <span className="ag-card-name">{nsDefaults.name} defaults</span>
            <span className="ag-card-foot">
              every microservice in {nsDefaults.name}
              {nsDefaults.count ? ` · ${nsDefaults.count} value${nsDefaults.count === 1 ? "" : "s"}` : ""}
            </span>
          </button>
          <Help label="namespace defaults">
            <p>
              Set once for every microservice in <strong>{nsDefaults.name}</strong> — a monorepo image tag, an
              environment label. Written to <code>{nsDefaults.name}/defaults.yaml</code>.
            </p>
            <p>
              The chain is <code>base/&lt;ms&gt;.yaml → &lt;ns&gt;/defaults.yaml → &lt;ns&gt;/values/&lt;ms&gt;.yaml</code>,
              later wins: these beat each microservice's base, and one microservice's own file here beats them.
            </p>
            <p>
              The <strong>shared</strong> release takes them too, and it runs no pods — keep workload-only settings (a
              Route, an HPA, replicas) off defaults.
            </p>
          </Help>
        </div>
      )}
      {cards.length > 1 && control}
      <div className="ag-card-grid" aria-label="Microservices">

      {sorted.map((card) => {
        // Grouped by what each thing *is*, not just listed: the workload, the
        // parts of its pod template, the objects beside it, and the
        // cluster-scoped ones that only one release may own. `resourcesOf`
        // returns them already in that order.
        const workload = card.resources.find((r) => r.scope === "workload");
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
            {(card.image || card.tag || workload) && (
              <span className="ag-card-image">
                {card.image || "no image"}
                {card.tag ? <b>:{card.tag}</b> : card.tag === null && workload && <i> · no tag</i>}
              </span>
            )}
            <span className="ag-card-chips">
              {SCOPES.map((scope) => {
                const inScope = card.resources.filter((r) => r.scope === scope);
                if (!inScope.length) return null;
                return (
                  <span className={`ag-chip-row ${scope}`} key={scope}>
                    {inScope.map((r) => (
                      <Chip
                        key={r.kind}
                        kind={r.kind}
                        names={r.names}
                        variant={r.scope}
                        feature={r.feature}
                        title={chipTitle(r)}
                      />
                    ))}
                  </span>
                );
              })}
              {card.extras.length > 0 && (
                // Its own row, not folded into the objects: these are what a
                // namespace override adds, and not what the base file creates.
                <span className="ag-chip-row added">
                  {card.extras.map((e) => (
                    <Chip
                      key={e.kind}
                      kind={e.kind}
                      variant="added"
                      feature={e.feature}
                      title={`Added by ${e.namespaces.join(", ")} — not in the base file${
                        e.feature ? "" : ". Select that namespace to open it."
                      }`}
                    />
                  ))}
                </span>
              )}
            </span>
            {card.envSpecific && (
              // On the card rather than in a row under the grid: this is a fact
              // about one microservice, and a stack of rows underneath made you
              // match a name back to a tile to know which. `title` rather than
              // the shared `?`, for the reason `Chip` above gives — the card is
              // a <button>, and a button cannot hold one.
              <span
                className="ag-card-warn linked"
                // Pressed, it lands on the field the warning is about, where the
                // same warning is repeated — see the card's own click handler.
                data-feature={featureForPath(card.envSpecific.paths[0])}
                data-to-base="1"
                title={`${card.envSpecific.namespaces.join(", ")} ${
                  card.envSpecific.namespaces.length === 1 ? "takes" : "take"
                } base's value as-is. Base is environment-agnostic, so these usually belong in each namespace's own file.`}
              >
                <AlertTriangle size={12} aria-hidden="true" />
                <span>
                  {card.envSpecific.paths.slice(0, 3).map((path, i) => (
                    <span key={path}>
                      {i > 0 && ", "}
                      <code>{path}</code>
                    </span>
                  ))}
                  {card.envSpecific.paths.length > 3 && ` +${card.envSpecific.paths.length - 3}`}
                  {card.envSpecific.paths.length === 1 ? " belongs" : " belong"} per-namespace
                </span>
              </span>
            )}
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
                  if (chip?.dataset.feature) onJump(card.id, chip.dataset.feature, chip.dataset.toBase === "1");
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

      <button
        type="button"
        className="ag-card ag-add-card"
        // Straight into the name: an unnamed card generates `release.yaml` and
        // is indistinguishable from the last one, and naming it later means
        // finding it again first.
        onClick={() => {
          const id = onAdd();
          if (id) setEditing(id);
        }}
      >
        <Plus size={15} aria-hidden="true" /> Microservice
      </button>

      {/* One per tree, so it disappears once there is one. It is a release like
          any other after this — the converter's own convention, not a mode. */}
      {onAddShared && (
        <span className="ag-add-shared">
          <button type="button" className="ag-card ag-add-card" onClick={onAddShared}>
            <Share2 size={15} aria-hidden="true" /> Shared
          </button>
          <Help label="the shared microservice">
            <p>
              A release named <code>shared</code> that runs no pods (<code>workload.type: none</code>) and exists only
              to own the objects several microservices in a namespace use — a ConfigMap, a Secret, a claim, a
              NetworkPolicy, a Role.
            </p>
            <p>
              Two Helm releases cannot both create an object of the same name, and these kinds are rendered under their
              raw map key with no release prefix. Declaring them once here is what lets every microservice beside it
              just reference them.
            </p>
            <p>
              It is an ordinary release otherwise — <code>base/shared.yaml</code> and <code>&lt;ns&gt;/values/shared.yaml</code>{" "}
              — which is the same shape <code>convert_to_universal_chart.py</code> writes, so a converted tree and one
              built here read alike.
            </p>
          </Help>
        </span>
      )}
      </div>
    </>
  );
}
