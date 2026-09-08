/** The exact snapshot owner is retained so a later explicit quit can retry it. */
export class SnapshotCleanupUnconfirmedError extends Error {
  constructor() { super("Snapshot worker cleanup is unconfirmed. Quit again to retry."); }
}

export async function cleanupWithSnapshots(
  snapshots: { dispose(): Promise<void> } | null,
  cleanupRemainingOwners: () => Promise<boolean>,
): Promise<boolean> {
  let snapshotConfirmed = true;
  try { await snapshots?.dispose(); } catch { snapshotConfirmed = false; }
  const remainingConfirmed = await cleanupRemainingOwners();
  if (!snapshotConfirmed) throw new SnapshotCleanupUnconfirmedError();
  return remainingConfirmed;
}
