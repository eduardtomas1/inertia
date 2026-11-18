/**
 * Which store a Cursor SDK run opens. A new agent lives in the store of the checkout it was created in, which every
 * Cursor SDK chat of that checkout shares (one exclusive lock). The first time a chat runs its agent in another
 * checkout, the agent is adopted into its own store and lives there from then on, wherever the chat runs, so chats
 * handed to different worktrees never wait for each other or for chats still running in the original checkout.
 *
 * - `checkout`: a new agent, or a resumed agent that never left its checkout.
 * - `agent`: the agent already has its own store.
 * - `adopt`: copy the agent from its original checkout's store into its own store, then run there.
 * - `unavailable`: the chat moved, the agent has no store of its own and its original store does not exist; the
 *   agent's records are gone, so the session is reported unavailable before any worker starts.
 *
 * Nothing durable outside the agent's store records an adoption: if that store alone is lost, the agent resumes
 * from the stale copy in its original checkout's store there.
 */
export type CursorSdkStorePlan = "checkout" | "agent" | "adopt" | "unavailable";

export function cursorSdkStorePlan(input: {
  resumed: boolean; moved: boolean; agentJournal: boolean; originStore: boolean;
}): CursorSdkStorePlan {
  if (!input.resumed) return "checkout";
  if (input.agentJournal) return "agent";
  if (!input.moved) return "checkout";
  return input.originStore ? "adopt" : "unavailable";
}
