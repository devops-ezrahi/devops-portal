import { CircleStop } from "lucide-react";
import { classifyLogLine } from "../../../logLines";
import type { JobLogEntry, WhiteningJob, WhiteningJobStatus } from "../../../../server/types";

type Props = {
  job: WhiteningJob;
  onStop: () => void;
};

/** Consecutive entries sharing a step become one collapsible group, Jenkins-style. */
function groupByStep(log: JobLogEntry[]): { step: string; lines: string[] }[] {
  const groups: { step: string; lines: string[] }[] = [];
  for (const entry of log) {
    const last = groups[groups.length - 1];
    if (last && last.step === entry.step) last.lines.push(entry.line);
    else groups.push({ step: entry.step, lines: [entry.line] });
  }
  return groups;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function statusClass(status: WhiteningJobStatus): string {
  switch (status) {
    case "pending": return "stage stage-submitted";
    case "in-progress": return "stage stage-in-progress";
    case "completed": return "stage stage-resolved";
    case "failed": return "stage stage-waiting-on-customer";
    case "aborted": return "stage stage-aborted";
  }
}

function statusLabel(status: WhiteningJobStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "in-progress": return "In Progress";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
  }
}

/** Only a job that hasn't reached an end state can be stopped. */
function isRunning(status: WhiteningJobStatus): boolean {
  return status === "pending" || status === "in-progress";
}

export function JobDetail({ job, onStop }: Props) {
  return (
    <article className="ticket-detail">
      <div className="detail-heading">
        <div className="badge-row">
          <span className={statusClass(job.status)}>{statusLabel(job.status)}</span>
          <span className="detail-id">{job.id}</span>
        </div>
        <div className="detail-title-row">
          <h2>{job.department}/{job.team}/{job.project}</h2>
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
          <div className="job-log-steps">
            {groupByStep(job.log).map((group, i, all) => (
              // Native <details>: no accordion state to keep in sync with polling.
              // The last step stays open while the job is still moving or has failed.
              <details
                key={`${group.step}-${i}`}
                className="job-log-step"
                open={i === all.length - 1 && job.status !== "completed"}
              >
                <summary>
                  {group.step}
                  <span className="job-log-count">{group.lines.length}</span>
                </summary>
                <pre className="job-log-body">
                  {group.lines.map((line, n) => (
                    // Per-package outcomes stand out from the surrounding CLI noise.
                    <span key={n} className={classifyLogLine(line).className}>
                      {line}
                      {n < group.lines.length - 1 ? "\n" : ""}
                    </span>
                  ))}
                </pre>
              </details>
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
