import type { ArtifactoryJob, ArtifactoryJobStatus } from "../../../../server/types";

type Props = {
  jobs: ArtifactoryJob[];
  selectedJobId: string | null;
  isAdmin: boolean;
  onSelect: (id: string) => void;
};

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

function jobSubtitle(job: ArtifactoryJob): string {
  if (job.kind === "url-copy" && job.sourceUrl) {
    return job.sourceUrl.length > 50
      ? job.sourceUrl.slice(0, 47) + "..."
      : job.sourceUrl;
  }
  return job.folderName ?? "";
}

export function JobList({ jobs, selectedJobId, isAdmin, onSelect }: Props) {
  if (jobs.length === 0) {
    return <div className="empty-state">No jobs yet. Submit a copy or upload above.</div>;
  }

  return (
    <>
      {jobs.map((job) => (
        <button
          key={job.id}
          className={`ticket-row${selectedJobId === job.id ? " selected" : ""}`}
          onClick={() => onSelect(job.id)}
        >
          <span className={statusClass(job.status)}>{statusLabel(job.status)}</span>
          <strong>{job.name ?? (job.kind === "url-copy" ? "URL Copy" : "Folder Upload")}</strong>
          <div className="ticket-row-meta">
            <small>{jobSubtitle(job) || job.id}</small>
            {/* Admins see who submitted it; users already know it's theirs. */}
            <small>{isAdmin ? job.submittedByName : job.id}</small>
          </div>
        </button>
      ))}
    </>
  );
}
