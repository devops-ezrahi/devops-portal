import { Pop } from "../../../Pop";
import { RowDelete } from "../../../RowDelete";
import { Loading } from "../../../Pending";
import { jobStatusClass, jobStatusLabel } from "../jobStatus";
import type { ArtifactoryJob } from "../../../../server/types";

type Props = {
  jobs: ArtifactoryJob[];
  /** False until the first list request settles — Loading, not "No … yet". */
  loaded?: boolean;
  selectedJobId: string | null;
  isAdmin: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
};

function jobSubtitle(job: ArtifactoryJob): string {
  if (job.kind === "url-copy" && job.sourceUrl) {
    return job.sourceUrl.length > 50
      ? job.sourceUrl.slice(0, 47) + "..."
      : job.sourceUrl;
  }
  return job.folderName ?? "";
}

export function JobList({ jobs, selectedJobId, isAdmin, onSelect, onDelete, loaded = true }: Props) {
  if (jobs.length === 0) {
    return loaded ? <div className="empty-state">No jobs yet. Submit a copy or upload above.</div> : <Loading what="jobs" />;
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
          <Pop value={jobStatusLabel(job)} className={jobStatusClass(job)}>{jobStatusLabel(job)}</Pop>
          <strong>{job.name ?? (job.kind === "url-copy" ? "URL Copy" : "Folder Upload")}</strong>
          <div className="ticket-row-meta">
            <small>{jobSubtitle(job) || job.id}</small>
            {/* Admins see who submitted it; users already know it's theirs. */}
            <small dir="auto">{isAdmin ? job.submittedByName : job.id}</small>
          </div>
        </button>
      ))}
    </>
  );
}
