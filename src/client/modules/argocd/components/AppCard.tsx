import { ExternalLink, GitBranch, GitCommit } from "lucide-react";
import type { ArgoCdApplicationSummary } from "../../../../server/types";

function formatMaybeDate(value?: string) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function shortHash(value: string) {
  return value && value !== "HEAD" ? value.slice(0, 7) : value || "Unknown";
}

function argoStatusClass(value: string) {
  return `argo-badge argo-${value.toLowerCase().replaceAll(" ", "-")}`;
}

function argoEnvClass(value: string) {
  return `argo-badge argo-env-${value}`;
}

export function AppCard({ app }: { app: ArgoCdApplicationSummary }) {
  return (
    <article className="simple-app-box">
      <div className="simple-app-heading">
        <div>
          <strong>{app.name}</strong>
          <small>{app.namespace} / {app.project}</small>
        </div>
        <span className={app.criticality === "critical" ? "argo-badge argo-danger" : "argo-badge"}>
          {app.criticality}
        </span>
      </div>

      <div className="simple-status-row">
        <span className={argoEnvClass(app.environment)}>{app.environment.toUpperCase()}</span>
        <span className={argoStatusClass(app.syncStatus)}>{app.syncStatus}</span>
        <span className={argoStatusClass(app.healthStatus)}>{app.healthStatus}</span>
        <span className={app.automated ? "argo-badge argo-auto" : "argo-badge"}>{app.syncMode}</span>
      </div>

      <dl className="simple-app-meta">
        <div><dt>Chart</dt><dd>{app.chartName}</dd></div>
        <div><dt>Chart version</dt><dd>{app.chartVersion}</dd></div>
        <div><dt>Image</dt><dd>{app.desiredImage}</dd></div>
        <div><dt>Repo</dt><dd>{app.repoName}</dd></div>
        <div><dt>Branch</dt><dd>{app.targetRevision}</dd></div>
        <div><dt>Commit</dt><dd>{shortHash(app.lastCommitHash)}</dd></div>
        <div><dt>Last sync</dt><dd>{formatMaybeDate(app.lastSyncedAt)}</dd></div>
        <div><dt>Sync result</dt><dd>{app.lastSyncResult}</dd></div>
      </dl>

      <div className="simple-app-actions">
        {app.links.git && (
          <a href={app.links.git} target="_blank" rel="noreferrer">
            <GitBranch size={15} aria-hidden="true" /> Repo
          </a>
        )}
        {app.links.commit && (
          <a href={app.links.commit} target="_blank" rel="noreferrer">
            <GitCommit size={15} aria-hidden="true" /> Commit
          </a>
        )}
        <a href={app.links.argoCd} target="_blank" rel="noreferrer">
          <ExternalLink size={15} aria-hidden="true" /> Argo CD
        </a>
      </div>
    </article>
  );
}
