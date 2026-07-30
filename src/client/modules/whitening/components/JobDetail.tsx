import type { WhiteningJob, WhiteningJobStatus } from "../../../../server/types";

type Props = {
  job: WhiteningJob;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function statusClass(status: WhiteningJobStatus): string {
  switch (status) {
    case "pending": return "stage stage-submitted";
    case "in-progress": return "stage stage-in-progress";
    case "completed": return "stage stage-resolved";
    case "failed": return "stage stage-waiting-on-customer";
  }
}

function statusLabel(status: WhiteningJobStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "in-progress": return "In Progress";
    case "completed": return "Completed";
    case "failed": return "Failed";
  }
}

export function JobDetail({ job }: Props) {
  return (
    <article className="ticket-detail">
      <div className="detail-heading">
        <span className={statusClass(job.status)}>{statusLabel(job.status)}</span>
        <h2>{job.department}/{job.team}/{job.project}</h2>
        <p>{job.id}</p>
      </div>

      {job.status === "failed" && job.errorMessage && (
        <div className="error-banner">{job.errorMessage}</div>
      )}

      <dl className="metadata-list">
        <div>
          <dt>Submitted by</dt>
          <dd>{job.submittedByName}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(job.createdAt)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(job.updatedAt)}</dd>
        </div>
        <div>
          <dt>Archive</dt>
          <dd>{job.archiveName}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{job.version}</dd>
        </div>
        {job.prUrl && (
          <div>
            <dt>Pull request</dt>
            <dd>
              <a href={job.prUrl} target="_blank" rel="noreferrer">{job.prUrl}</a>
            </dd>
          </div>
        )}
      </dl>

      <section>
        <h3>Progress Log</h3>
        {job.log.length === 0 ? (
          <div className="empty-state">No log entries yet.</div>
        ) : (
          <div className="comments">
            {job.log.map((line, i) => (
              <div key={i} className="status-row">
                <span>{line}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
