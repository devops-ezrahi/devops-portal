import type { BranchDiffItem } from "../../../../server/types";

export function DiffList({
  items,
  branches,
  emptyText,
}: {
  items: BranchDiffItem[];
  branches: string[];
  emptyText: string;
}) {
  if (items.length === 0) {
    return <div className="diff-list-empty">{emptyText}</div>;
  }
  return (
    <div className="diff-list">
      <div className="diff-list-header">
        <span>Field</span>
        {branches.map((b) => <span key={b}>{b.replace("payments-", "")}</span>)}
      </div>
      {items.map((item) => (
        <div key={item.field} className="diff-list-row">
          <strong>{item.field}</strong>
          {branches.map((b) => <span key={b}>{item.values[b] ?? "—"}</span>)}
        </div>
      ))}
    </div>
  );
}
