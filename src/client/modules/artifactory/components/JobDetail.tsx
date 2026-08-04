import { CircleStop } from "lucide-react";
import { classifyLogLine } from "../../../logLines";
import type { ArtifactoryJob, ArtifactoryJobStatus, PackageUploadStatus } from "../../../../server/types";

type Props = {
  job: ArtifactoryJob;
  onStop: () => void;
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
    case "aborted": return "stage stage-aborted";
  }
}

function statusLabel(status: ArtifactoryJobStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "in-progress": return "In Progress";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
  }
}

/** Only a job that hasn't reached an end state can be stopped. */
function isRunning(status: ArtifactoryJobStatus): boolean {
  return status === "pending" || status === "in-progress";
}

function packageStatusClass(status: PackageUploadStatus): string {
  switch (status) {
    case "uploaded": return "stage-resolved";
    case "exists": return "stage-submitted";
    case "failed": return "stage-waiting-on-customer";
  }
}

function packageStatusLabel(status: PackageUploadStatus): string {
  switch (status) {
    case "uploaded": return "Uploaded";
    case "exists": return "Already there";
    case "failed": return "Failed";
  }
}

export function JobDetail({ job, onStop }: Props) {
  return (
    <article className="ticket-detail">
      <div className="detail-heading">
        <span className={statusClass(job.status)}>{statusLabel(job.status)}</span>
        <h2>{job.name ?? (job.kind === "url-copy" ? "URL Copy" : "Folder Upload")}</h2>
        <p>{job.id}</p>
        {isRunning(job.status) && (
          <button className="ghost-button" onClick={onStop}>
            <CircleStop size={16} aria-hidden="true" /> Stop
          </button>
        )}
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

        {job.resultUrl && (
          <div>
            <dt>Artifactory</dt>
            <dd>
              <a href={job.resultUrl} target="_blank" rel="noreferrer">View in Artifactory</a>
            </dd>
          </div>
        )}
      </dl>

      {job.progress && job.progress.total > 0 && (
        <section>
          <h3>Progress</h3>
          <progress className="job-progress" value={job.progress.done} max={job.progress.total} />
          <p className="field-hint">
            {job.progress.done} of {job.progress.total} package(s)
          </p>
        </section>
      )}

      {job.packages && job.packages.length > 0 && (
        <section>
          <h3>Packages</h3>
          <div className="package-table">
            {job.packages.map((pkg) => (
              <div key={pkg.path} className="package-row">
                <span className="package-name">
                  {pkg.url ? (
                    <a href={pkg.url} target="_blank" rel="noreferrer">{pkg.name}@{pkg.version}</a>
                  ) : (
                    <>{pkg.name}@{pkg.version}</>
                  )}
                </span>
                <span className={`stage ${packageStatusClass(pkg.status)}`}>{packageStatusLabel(pkg.status)}</span>
                {pkg.error && <span className="package-error">{pkg.error}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h3>Progress Log</h3>
        {job.log.length === 0 ? (
          <div className="empty-state">No log entries yet.</div>
        ) : (
          <div className="comments">
            {job.log.map((line, i) => {
              const entry = classifyLogLine(line);
              return (
                <div key={i} className={`status-row ${entry.className}`.trim()}>
                  <span>
                    {entry.pkg && <strong className="log-pkg">{entry.pkg}</strong>}
                    {entry.text}
                  </span>
                  {entry.badge && <small>{entry.badge}</small>}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </article>
  );
}
