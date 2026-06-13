import type { ArtifactoryJob, ArtifactoryJobStatus } from "../../../../server/types";

type Props = {
  job: ArtifactoryJob;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function statusClass(status: ArtifactoryJobStatus): string {
  switch (status) {
    case "pending": return "stage stage-submitted";
    case "in-progress": return "stage stage-in-progress";
    case "completed": return "stage stage-resolved";
    case "failed": return "stage stage-waiting-on-customer";
  }
}

function statusLabel(status: ArtifactoryJobStatus): string {
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
        <h2>{job.kind === "url-copy" ? "URL Copy" : "Folder Upload"}</h2>
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

        {job.kind === "url-copy" && job.sourceUrl && (
          <div>
            <dt>Source URL</dt>
            <dd>{job.sourceUrl}</dd>
          </div>
        )}

        {job.kind === "folder-upload" && job.folderName && (
          <div>
            <dt>Folder</dt>
            <dd>{job.folderName}</dd>
          </div>
        )}

        {job.kind === "folder-upload" && job.fileCount !== undefined && (
          <div>
            <dt>Files</dt>
            <dd>{job.fileCount.toLocaleString()}</dd>
          </div>
        )}

        {job.kind === "folder-upload" && job.totalBytes !== undefined && (
          <div>
            <dt>Size</dt>
            <dd>{formatBytes(job.totalBytes)}</dd>
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
