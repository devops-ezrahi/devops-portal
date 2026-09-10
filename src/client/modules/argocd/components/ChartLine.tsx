import { useState } from "react";
import { Pencil } from "lucide-react";
import { normalizeRepoUrl } from "../../../../server/gitUrl";
import { repoName } from "./RepoPanel";
import type { DraftTree } from "../document";

/**
 * The chart, as one line.
 *
 * It used to be half of a two-repo disclosure, given the same weight as the
 * values repo. It has not earned that: the universal chart is a deployment
 * fact, set once per organisation, and a tree connected to a repository does
 * not even ask for it — `importTree` reads it out of that repo's own
 * `root-applicationSet.yaml`. So it states itself and gets out of the way,
 * with a pencil for the once a year somebody moves the chart.
 */
export function ChartLine({
  tree,
  onChange,
  onRootAppName,
}: {
  tree: DraftTree;
  onChange: (chart: DraftTree["chart"]) => void;
  onRootAppName: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="ag-chart-line">
      <div className="ag-chart-summary">
        <span className="ag-chart-label">Chart</span>
        <span className="ag-chart-ref">
          {repoName(tree.chart.repoUrl)}
          <span className="ag-repo-rev">@{tree.chart.revision || "?"}</span>
        </span>
        <span className="ag-chart-paths">
          {tree.chart.path || "."} · {tree.chart.appsetPath || "ms-applicationSet"}
        </span>
        <button
          type="button"
          className="icon-button edit-toggle"
          aria-label={editing ? "Done editing the chart" : "Change the chart"}
          aria-expanded={editing}
          onClick={() => setEditing((v) => !v)}
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
      </div>

      {editing && (
        <div className="ag-repo">
          <p className="ag-repo-note">
            <strong>Chart</strong> — the universal chart every release in this tree renders. Read-only; nothing here
            is committed to it.
          </p>
          <label>
            <span>Chart repo URL</span>
            <input
              value={tree.chart.repoUrl}
              placeholder="https://github.com/devops-ezrahi/universal-chart.git"
              onChange={(e) => onChange({ ...tree.chart, repoUrl: e.target.value })}
              onBlur={(e) => onChange({ ...tree.chart, repoUrl: normalizeRepoUrl(e.target.value) })}
            />
          </label>
          <label>
            <span>Branch or tag</span>
            <input
              value={tree.chart.revision}
              placeholder="main"
              onChange={(e) => onChange({ ...tree.chart, revision: e.target.value })}
            />
          </label>
          <label>
            <span>Chart path in that repo</span>
            <input
              value={tree.chart.path}
              placeholder="."
              onChange={(e) => onChange({ ...tree.chart, path: e.target.value })}
            />
          </label>
          <label>
            <span>Fan-out chart path</span>
            <input
              placeholder="ms-applicationSet"
              value={tree.chart.appsetPath}
              onChange={(e) => onChange({ ...tree.chart, appsetPath: e.target.value })}
            />
          </label>
          <label>
            {/* Wiring, not values — it names the one object applied by hand,
                so it belongs beside the chart rather than in the tree's data. */}
            <span>Root Application name</span>
            <input
              value={tree.rootAppName}
              placeholder="platform-root"
              onChange={(e) => onRootAppName(e.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}
