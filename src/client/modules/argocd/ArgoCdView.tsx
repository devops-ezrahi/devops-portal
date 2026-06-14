import { RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listArgoCdProjects } from "./api";
import { AppCard } from "./components/AppCard";
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
