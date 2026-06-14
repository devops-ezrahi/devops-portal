import { DiffList } from "./DiffList";
import type { BranchDiffDashboard, BranchDiffMicroservice } from "../../../../server/types";

function riskClass(risk: string) {
  return `diff-risk diff-risk-${risk}`;
}

export function ServiceDetail({
  dashboard,
  service,
}: {
  dashboard: BranchDiffDashboard;
  service: BranchDiffMicroservice;
}) {
  return (
    <article className="branch-service-detail">
      <div className="detail-heading">
        <div>
          <span className={riskClass(service.riskLevel)}>{service.riskLevel}</span>
          <h2>{service.name}</h2>
          <p>{service.badges.join(" / ")}</p>
        </div>
      </div>

      <section>
        <h3>Summary</h3>
        <div className="branch-summary-list">
          {service.summary.map((item) => <div key={item}>{item}</div>)}
        </div>
      </section>

      <section>
        <h3>Important fields</h3>
        <div className="important-fields">
          <div className="important-fields-header">
            <span>Field</span>
            {dashboard.branches.map((b) => <span key={b}>{b.replace("payments-", "")}</span>)}
            <span>Risk</span>
          </div>
          {service.importantFields.map((field) => (
            <div key={field.field} className="important-field-row">
              <strong>{field.field}</strong>
              {dashboard.branches.map((b) => <span key={b}>{field.values[b]}</span>)}
              <span className={riskClass(field.risk)}>{field.risk}</span>
            </div>
          ))}
          {service.importantFields.length === 0 && (
            <div className="empty-state">No important field drift.</div>
          )}
        </div>
      </section>

      <section>
        <h3>Values diff</h3>
        <DiffList items={service.valuesDiffs} branches={dashboard.branches} emptyText="No values drift." />
      </section>

      <section>
        <h3>Template diff</h3>
        <DiffList items={service.templateDiffs} branches={dashboard.branches} emptyText="No template drift." />
      </section>

      <section>
        <h3>Resource diff</h3>
        <DiffList items={service.resourceDiffs} branches={dashboard.branches} emptyText="No resource drift." />
      </section>
    </article>
  );
}
