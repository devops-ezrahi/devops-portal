import { RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getGitRepoDiff } from "./api";
import { ServiceDetail } from "./components/ServiceDetail";
import type { ModuleViewProps } from "../../moduleTypes";
import type { BranchDiffDashboard } from "../../../server/types";

function riskClass(risk: string) {
  return `diff-risk diff-risk-${risk}`;
}

type DiffFilter =
  | "all"
  | "template"
  | "values"
  | "high"
  | "prod"
  | "missing"
  | "secure"
  | "image"
  | "routeSecurity";

const filters: Array<{ id: DiffFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "template", label: "Template changes" },
  { id: "values", label: "Values changes" },
  { id: "high", label: "High risk" },
  { id: "prod", label: "Production differences" },
  { id: "missing", label: "Missing services" },
  { id: "secure", label: "Secure-prd differences" },
  { id: "image", label: "Image differences" },
  { id: "routeSecurity", label: "Route/security/RBAC" },
];

export function BranchDiffView({ refreshKey, onError }: ModuleViewProps) {
  const [dashboard, setDashboard] = useState<BranchDiffDashboard | null>(null);
  const [selectedServiceName, setSelectedServiceName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DiffFilter>("all");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await getGitRepoDiff();
      setDashboard(result);
      setSelectedServiceName((current) => current || result.microservices[0]?.name || "");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load branch diff";
      setError(msg);
      onError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [refreshKey]);

  const filteredServices = useMemo(() => {
    if (!dashboard) return [];
    return dashboard.microservices.filter((s) => {
      if (filter === "template") return s.templateDrift;
      if (filter === "values") return s.valuesDrift;
      if (filter === "high") return s.riskLevel === "high";
      if (filter === "prod") return s.productionDifference;
      if (filter === "missing") return s.missingBranches.length > 0;
      if (filter === "secure") return s.secureDifference;
      if (filter === "image") return s.badges.includes("Image differs");
      if (filter === "routeSecurity")
        return s.badges.some((b) => ["Route changed", "Security changed", "NetworkPolicy changed"].includes(b));
      return true;
    });
  }, [dashboard, filter]);

  const selectedService = useMemo(
    () => dashboard?.microservices.find((s) => s.name === selectedServiceName) ?? dashboard?.microservices[0],
    [dashboard, selectedServiceName]
  );

  if (error) {
    return (
      <div className="branch-diff-space">
        <header className="topbar"><h1>Microservice Branch Diff</h1></header>
        <div className="error-banner">
          {error}
          <button className="ghost-button" onClick={() => load()}>
            <RefreshCcw size={16} aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (loading || !dashboard) {
    return (
      <div className="branch-diff-space">
        <header className="topbar"><h1>Microservice Branch Diff</h1></header>
        <div className="loading-state" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="branch-diff-space">
      <header className="topbar"><h1>Microservice Branch Diff</h1></header>

      <section className="branch-diff-toolbar">
        <div>
          <span>App</span>
          <strong>{dashboard.app}</strong>
        </div>
        <div>
          <span>Baseline branch</span>
          <strong>{dashboard.baselineBranch}</strong>
        </div>
        <div>
          <span>Compare branches</span>
          <strong>{dashboard.branches.filter((b) => b !== dashboard.baselineBranch).join(", ")}</strong>
        </div>
      </section>

      <section className="branch-summary" aria-label="Branch diff summary">
        <div><span>Branches</span><strong>{dashboard.summary.totalBranches}</strong></div>
        <div><span>Microservices</span><strong>{dashboard.summary.totalMicroservices}</strong></div>
        <div><span>Same</span><strong>{dashboard.summary.sameAcrossAllBranches}</strong></div>
        <div><span>Values drift</span><strong>{dashboard.summary.valuesDrift}</strong></div>
        <div><span>Template drift</span><strong>{dashboard.summary.templateDrift}</strong></div>
        <div><span>Missing</span><strong>{dashboard.summary.missingMicroservices}</strong></div>
        <div><span>High risk</span><strong>{dashboard.summary.highRiskDifferences}</strong></div>
        <div><span>Prod drift</span><strong>{dashboard.summary.productionDifferences}</strong></div>
        <div><span>Secure drift</span><strong>{dashboard.summary.secureNetworkDifferences}</strong></div>
      </section>

      <section className="argo-controls">
        <div className="argo-quick-filters">
          {filters.map((f) => (
            <button
              key={f.id}
              className={filter === f.id ? "active" : ""}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </section>

      <div className="branch-diff-layout">
        <section className="branch-matrix">
          <div className="branch-matrix-header">
            <span>Microservice</span>
            {dashboard.branches.map((b) => <span key={b}>{b.replace("payments-", "")}</span>)}
            <span>Drift</span>
            <span>Risk</span>
          </div>
          {filteredServices.map((service) => (
            <button
              key={service.name}
              className={selectedService?.name === service.name ? "branch-row selected" : "branch-row"}
              onClick={() => setSelectedServiceName(service.name)}
            >
              <strong>{service.name}</strong>
              {dashboard.branches.map((branch) => {
                const snap = service.branches[branch];
                return (
                  <span key={branch} className={snap.exists ? "branch-cell" : "branch-cell missing"}>
                    {snap.exists ? (
                      <>
                        <b>{snap.imageTag ?? "no image"}</b>
                        <small>{snap.replicaCount ?? "-"} replicas</small>
                      </>
                    ) : (
                      <b>Missing</b>
                    )}
                  </span>
                );
              })}
              <span className="branch-badges">
                {service.badges.slice(0, 3).map((badge) => <em key={badge}>{badge}</em>)}
              </span>
              <span className={riskClass(service.riskLevel)}>{service.riskLevel}</span>
            </button>
          ))}
          {filteredServices.length === 0 && (
            <div className="empty-state">No microservices match this filter.</div>
          )}
        </section>

        <section className="branch-detail detail-panel">
          {selectedService ? (
            <ServiceDetail dashboard={dashboard} service={selectedService} />
          ) : (
            <div className="empty-state">Select a microservice.</div>
          )}
        </section>
      </div>
    </div>
  );
}
