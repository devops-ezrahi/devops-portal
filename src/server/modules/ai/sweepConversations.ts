import type { AiConversation, AiJob } from "../../types";

/**
 * Idle policy for chats. These are throwaway Q&A threads against a repo, not
 * tickets — a chat nobody has touched in hours is done, so it folds into the
 * client's collapsed "Archived" list. `updatedAt` is already stamped on every
 * question and every job state change, so it is the only clock this needs.
 *
 * Archiving is reversible and costs nothing: reopening a chat and asking again
 * clears the flag in `submitQuestion` and re-pulls the repo clone in `run()`.
 * Un-archiving lives there, not here, so that a chat archived by hand from the
 * UI stays archived — this sweep would otherwise clear the flag off it on the
 * very next read, since a just-used chat is not idle.
 *
 * There is deliberately no delete any more. Chats and their jobs live on the
 * PVC, so nothing has to be dropped to reclaim `AiJob.thinking` plus `log[]`.
 * If the volume ever fills, delete files on it.
 */
export function sweepConversations(
  conversations: Map<string, AiConversation>,
  jobs: Iterable<Pick<AiJob, "conversationId" | "status">>,
  archiveAfterMs: number,
  now = Date.now()
): { archived: string[] } {
  // Ids, not a count: the caller has to persist each chat it just stamped.
  const archived: string[] = [];

  // A chat with work in flight is never idle, whatever its timestamps say — its
  // abort controller is live and someone is watching the answer land.
  const busy = new Set<string>();
  for (const job of jobs) {
    if (job.status === "pending" || job.status === "in-progress") busy.add(job.conversationId);
  }

  for (const [id, conversation] of conversations) {
    if (conversation.archivedAt) continue;
    const idleMs = now - Date.parse(conversation.updatedAt);
    if (Number.isNaN(idleMs)) continue;
    if (busy.has(id)) continue;

    if (idleMs >= archiveAfterMs) {
      // Deliberately not via patchConversation: `updatedAt` is what the client
      // sorts the list by, and archiving is not a use of the chat.
      conversation.archivedAt = new Date(now).toISOString();
      archived.push(id);
    }
  }

  return { archived };
}
