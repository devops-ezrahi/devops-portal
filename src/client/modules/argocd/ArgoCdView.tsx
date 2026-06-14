import { ExternalLink, GitBranch, GitCommit, RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listArgoCdProjects } from "../../api";
import type { ModuleViewProps } from "../../moduleTypes";
import type { ArgoCdApplicationSummary, ArgoCdDashboardTotals } from "../../../server/types";

const emptyTotals: ArgoCdDashboardTotals = {
  applications: 0,
  outOfSync: 0,
  degraded: 0,
  criticalApps: 0,
  prodApps: 0,
  autoSyncEnabled: 0,
  waitingForSync: 0,
  failedSync: 0,
  openPrs: 0,
  notOnBaseline: 0,
  chartDrift: 0,
  productionRisks: 0,
};

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

type QuickFilter = "all" | "prod" | "outofsync" | "failed";

const quickFilters: Array<{ id: QuickFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "prod", label: "PRD only" },
  { id: "outofsync", label: "OutOfSync" },
  { id: "failed", label: "Failed sync" },
];

export function ArgoCdView({ refreshKey, onError }: ModuleViewProps) {
  const [applications, setApplications] = useState<ArgoCdApplicationSummary[]>([]);
  const [totals, setTotals] = useState<ArgoCdDashboardTotals>(emptyTotals);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await listArgoCdProjects();
      setApplications(result.applications);
      setTotals(result.totals);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load Argo CD projects";
      setError(msg);
      onError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [refreshKey]);

  const filtered = useMemo(() => {
    return applications.filter((app) => {
      if (quickFilter === "prod") return app.environment === "prd";
      if (quickFilter === "outofsync") return app.syncStatus === "OutOfSync";
      if (quickFilter === "failed") return app.lastSyncResult === "Failed" || app.lastSyncResult === "Error";
      return true;
    });
  }, [applications, quickFilter]);

  return (
    <div className="argo-space">
      <header className="topbar">
        <h1>Argo CD</h1>
      </header>

      {error && (
        <div className="error-banner">
          {error}
          <button className="ghost-button" onClick={() => load()}>
            <RefreshCcw size={16} aria-hidden="true" /> Retry
          </button>
        </div>
      )}

      <section className="argo-summary" aria-label="Argo CD summary">
        <div className={totals.outOfSync > 0 ? "risk-card warning" : "risk-card"}>
          <span>OutOfSync</span>
          <strong>{totals.outOfSync}</strong>
        </div>
        <div>
          <span>Applications</span>
          <strong>{totals.applications}</strong>
        </div>
        <div>
          <span>PRD apps</span>
          <strong>{totals.prodApps}</strong>
        </div>
        <div>
          <span>Failed sync</span>
          <strong>{totals.failedSync}</strong>
        </div>
      </section>

      {loading ? (
        <div className="loading-state" aria-label="Loading" />
      ) : applications.length === 0 ? (
        <div className="empty-state">No Argo CD applications visible.</div>
      ) : (
        <>
          <section className="argo-controls" aria-label="Filters">
            <div className="argo-quick-filters">
              {quickFilters.map((f) => (
                <button
                  key={f.id}
                  className={quickFilter === f.id ? "active" : ""}
                  onClick={() => setQuickFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </section>

          <div className="simple-app-grid" aria-label="Argo CD applications">
            {filtered.map((app) => (
              <AppCard key={`${app.namespace}/${app.name}`} app={app} />
            ))}
            {filtered.length === 0 && (
              <div className="empty-state">No applications match the current filter.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AppCard({ app }: { app: ArgoCdApplicationSummary }) {
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
