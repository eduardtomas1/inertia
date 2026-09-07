import type { AgentTurn } from "../../../shared/contracts";

type SettledOwner = (turn: AgentTurn) => void | Promise<void>;

/** Each existing durable owner gets the exact terminal edge, once. */
export async function dispatchSettledTurnOwners(
  turn: AgentTurn,
  owners: readonly SettledOwner[],
  scheduleBackup?: () => Promise<unknown>,
): Promise<void> {
  // Completions, failures and cancellations all restart the existing quiet
  // backup window. Backup failure cannot suppress lifecycle owners.
  if (scheduleBackup) void Promise.resolve().then(scheduleBackup).catch(() => undefined);
  // Defer invocation as well as await: a synchronous failure in one owner
  // cannot suppress another owner's durable reconciliation. Do not retry;
  // conversation-scoped callbacks could otherwise act on a newer turn.
  const results = await Promise.allSettled(owners.map((owner) =>
    Promise.resolve().then(() => owner(turn))));
  if (results.some(({ status }) => status === "rejected")) {
    throw new Error("Required turn follow-up did not finish.");
  }
}
