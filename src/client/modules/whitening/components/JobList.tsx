import { Pop } from "../../../Pop";
import { RowDelete } from "../../../RowDelete";
import { Loading } from "../../../Spinner";
import { Spinner } from "../../../Spinner";
import type { WhiteningJob, WhiteningJobStatus } from "../../../../server/types";

type Props = {
  jobs: WhiteningJob[];
  /** False until the first list request settles — Loading, not "No … yet". */
  loaded?: boolean;
  selectedJobId: string | null;
  isAdmin: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

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

export function JobList({ jobs, selectedJobId, isAdmin, onSelect, onDelete, loaded = true }: Props) {
  if (jobs.length === 0) {
    return loaded ? <div className="empty-state">No jobs yet. Drop a pack above.</div> : <Loading what="jobs" />;
  }

  return (
    <>
      {jobs.map((job) => (
        <button
          key={job.id}
          className={`ticket-row${selectedJobId === job.id ? " selected" : ""}`}
          onClick={() => onSelect(job.id)}
        >
          {/* A running job is Stopped first, not deleted out from under its log. */}
          {job.status !== "pending" && job.status !== "in-progress" && (
            <RowDelete label={job.id} onDelete={() => onDelete(job.id)} />
          )}
          <Pop value={job.status} className={statusClass(job.status)}>{(job.status === "pending" || job.status === "in-progress") && !job.pendingPreserve?.length && <Spinner size={11} />}{statusLabel(job.status)}</Pop>
          <strong>{job.team}/{job.project}</strong>
          <div className="ticket-row-meta">
            <small>{job.archiveName}</small>
            {/* Admins see who submitted it; users already know it's theirs. */}
            <small dir="auto">{isAdmin ? job.submittedByName : job.id}</small>
          </div>
        </button>
      ))}
    </>
  );
}
