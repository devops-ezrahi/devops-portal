import type { ArtifactoryJob } from "../../../server/types";

/**
 * The badge for a job, in both the list and the drawer — one copy, because a
 * dependency fallback has to read the same in the list you scan as in the job
 * you opened.
 *
 * "Incomplete" is not a status the server stores: the job really did complete
 * the copy it was asked for, and failing it would be a lie in the other
 * direction. It is `completed` plus `dependencyFallback` — the one case where
 * "Completed" on its own claims more than happened.
 */
export function jobStatusLabel(job: ArtifactoryJob): string {
  if (job.status === "completed" && job.dependencyFallback) return "Incomplete";
  switch (job.status) {
    case "pending": return "Pending";
    case "in-progress": return "In Progress";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "aborted": return "Aborted";
  }
}

export function jobStatusClass(job: ArtifactoryJob): string {
  if (job.status === "completed" && job.dependencyFallback) return "stage stage-incomplete";
  switch (job.status) {
    case "pending": return "stage stage-submitted";
    case "in-progress": return "stage stage-in-progress";
    case "completed": return "stage stage-resolved";
    case "failed": return "stage stage-waiting-on-customer";
    case "aborted": return "stage stage-aborted";
  }
}
