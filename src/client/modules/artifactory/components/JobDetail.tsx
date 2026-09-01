import { CircleStop } from "lucide-react";
import { classifyLogLine } from "../../../logLines";
import { jobStatusClass, jobStatusLabel } from "../jobStatus";
import type {
  ArtifactoryJob,
  ArtifactoryJobStatus,
  PackageUploadResult,
  PackageUploadStatus,
} from "../../../../server/types";

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

/**
 * One row per package, not per file. A Maven copy uploads the jar *and* its
 * pom — same coordinates, two files — and listing them separately read as two
 * different packages that happened to share a name. Folder uploads pair them
 * the same way, plus `.sha1`/`.asc` sidecars and `-sources.jar` classifiers.
 *
 * The badge is the worst status in the group: a pom that failed while the jar
 * landed is a broken copy, and rolling it up as "Uploaded" would hide that.
 */
type PackageGroup = {
  key: string;
  main: PackageUploadResult;
  status: PackageUploadStatus;
  files: number;
  error?: string;
};

const SIDECAR = /\.(pom|sha1|sha256|sha512|md5|asc|module)$/i;
const WORST: PackageUploadStatus[] = ["exists", "uploaded", "failed"];

function groupPackages(packages: PackageUploadResult[]): PackageGroup[] {
  const groups = new Map<string, PackageGroup>();
  for (const pkg of packages) {
    const key = `${pkg.type ?? ""}|${pkg.name}@${pkg.version}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { key, main: pkg, status: pkg.status, files: 1, error: pkg.error });
      continue;
    }
    group.files++;
    // The jar, not its pom, is what the link should point at.
    if (SIDECAR.test(group.main.path) && !SIDECAR.test(pkg.path)) group.main = pkg;
    if (WORST.indexOf(pkg.status) > WORST.indexOf(group.status)) group.status = pkg.status;
    if (pkg.error && pkg.error !== group.error) {
      group.error = group.error ? `${group.error}; ${pkg.error}` : pkg.error;
    }
  }
  return [...groups.values()];
}

export function JobDetail({ job, onStop }: Props) {
  return (
    <article className="ticket-detail">
      <div className="detail-heading">
        <div className="badge-row">
          <span className={jobStatusClass(job)}>{jobStatusLabel(job)}</span>
          <span className="detail-id">{job.id}</span>
        </div>
        <div className="detail-title-row">
          <h2>{job.name ?? (job.kind === "url-copy" ? "URL Copy" : "Folder Upload")}</h2>
          {isRunning(job.status) && (
            <button className="ghost-button" onClick={onStop}>
              <CircleStop size={16} aria-hidden="true" /> Stop
            </button>
          )}
        </div>
      </div>

      {job.status === "failed" && job.errorMessage && (
        <div className="error-banner">{job.errorMessage}</div>
      )}

      {/* A fallback is not a failure, so the status badge still says Completed —
          which on its own reads as "dependencies copied fine". */}
      {job.dependencyFallback && (
        <div className="warn-banner">
          Dependencies were not copied: {job.dependencyFallback}
        </div>
      )}

      <dl className="metadata-list">
        <div>
          <dt>Submitted by</dt>
          <dd dir="auto">{job.submittedByName}</dd>
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

        {job.kind === "url-copy" && job.includeDependencies && (
          <div>
            <dt>Dependencies</dt>
            <dd>{job.dependencyFallback ? "Requested, not copied" : "Included"}</dd>
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
            {groupPackages(job.packages).map(({ key, main, status, files, error }) => (
              <div key={key} className="package-row">
                <span className="package-name">
                  {main.url ? (
                    <a href={main.url} target="_blank" rel="noreferrer">{main.name}@{main.version}</a>
                  ) : (
                    <>{main.name}@{main.version}</>
                  )}
                  {files > 1 && <span className="package-native-link">{files} files</span>}
                  {main.nativeUrl && (
                    <a className="package-native-link" href={main.nativeUrl} target="_blank" rel="noreferrer">
                      direct link
                    </a>
                  )}
                </span>
                <span className={`stage ${packageStatusClass(status)}`}>{packageStatusLabel(status)}</span>
                {error && <span className="package-error">{error}</span>}
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
