import type { WhiteningJob, WhiteningJobStatus } from "../../../../server/types";

type Props = {
  jobs: WhiteningJob[];
  selectedJobId: string | null;
  isAdmin: boolean;
  onSelect: (id: string) => void;
};

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

export function JobList({ jobs, selectedJobId, isAdmin, onSelect }: Props) {
  if (jobs.length === 0) {
    return <div className="empty-state">No jobs yet. Drop a packed .tgz above.</div>;
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
          <strong>{job.team}/{job.project}</strong>
          <div className="ticket-row-meta">
            <small>{job.archiveName}</small>
            {/* Admins see who submitted it; users already know it's theirs. */}
            <small>{isAdmin ? job.submittedByName : job.id}</small>
          </div>
        </button>
      ))}
    </>
  );
}
