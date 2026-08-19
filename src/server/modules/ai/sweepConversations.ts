import type { AiConversation, AiJob } from "../../types";

/**
 * Idle policy for chats. These are throwaway Q&A threads against a repo, not
 * tickets — a chat nobody has touched in hours is done, and one nobody has
 * touched in days is dead. `updatedAt` is already stamped on every question and
 * every job state change, so it is the only clock this needs.
 *
 * Archiving is reversible and costs nothing: reopening a chat and asking again
 * restamps `updatedAt`, which clears the flag here and re-pulls the repo clone
 * in `run()`. Deleting is not — it drops the conversation and every job with it,
 * which is the point: `AiJob.thinking` plus `log[]` is the fattest payload the
 * server holds, and nothing else ever removes it.
 *
 * ponytail: the opencode session state on disk (keyed by `opencodeSessionId`) is
 * orphaned, not freed, when a chat is deleted. opencode owns that store; sweep
 * it there if it ever matters.
 */
export function sweepConversations(
  conversations: Map<string, AiConversation>,
  jobs: Map<string, AiJob>,
  archiveAfterMs: number,
  deleteAfterMs: number,
  now = Date.now()
): { archived: number; deleted: number } {
  let archived = 0;
  let deleted = 0;

  // A chat with work in flight is never idle, whatever its timestamps say — its
  // abort controller is live and someone is watching the answer land. Same guard
  // artifactory's job-history cap uses.
  const busy = new Set<string>();
  for (const job of jobs.values()) {
    if (job.status === "pending" || job.status === "in-progress") busy.add(job.conversationId);
  }

  for (const [id, conversation] of conversations) {
    const idleMs = now - Date.parse(conversation.updatedAt);
    if (Number.isNaN(idleMs)) continue;
    // Only the two destructive branches are gated on this. Skipping a busy chat
    // outright would also skip the un-archive below, so asking a question in an
    // archived chat would leave it under "Archived" until the answer landed —
    // precisely while the user is watching it.
    const idle = !busy.has(id);

    if (idle && idleMs >= deleteAfterMs) {
      conversations.delete(id);
      for (const [jobId, job] of jobs) {
        if (job.conversationId === id) jobs.delete(jobId);
      }
      deleted++;
    } else if (idle && idleMs >= archiveAfterMs) {
      // Deliberately not via patchConversation: restamping `updatedAt` here
      // would reset the clock and no chat would ever age past archive.
      if (!conversation.archivedAt) {
        conversation.archivedAt = new Date(now).toISOString();
        archived++;
      }
    } else if (conversation.archivedAt) {
      delete conversation.archivedAt;
    }
  }

  return { archived, deleted };
}
