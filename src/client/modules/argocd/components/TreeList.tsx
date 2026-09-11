import type { ArgocdTree } from "../../../../server/types";

type Props = {
  trees: ArgocdTree[];
  selectedId: string;
  isAdmin: boolean;
  onSelect: (id: string) => void;
};

/** Same row shape and size as every other module's list panel. */
export function TreeList({ trees, selectedId, isAdmin, onSelect }: Props) {
  if (trees.length === 0) {
    return <div className="empty-state">No trees yet. Add a microservice and this fills in — saving is automatic.</div>;
  }

  return (
    <>
      {trees.map((tree) => (
        <button
          key={tree.id}
          className={`ticket-row${selectedId === tree.id ? " selected" : ""}`}
          onClick={() => onSelect(tree.id)}
        >
          <strong>{tree.name}</strong>
          <div className="ticket-row-meta">
            <small>
              {tree.releases.length} microservice{tree.releases.length === 1 ? "" : "s"} ·{" "}
              {tree.namespaces.length} namespace{tree.namespaces.length === 1 ? "" : "s"}
            </small>
            {/* Admins see every tree, so the owner is the useful column; a user
                is only ever looking at their own. */}
            <small dir="auto">{isAdmin ? tree.createdByName : tree.id}</small>
          </div>
        </button>
      ))}
    </>
  );
}
