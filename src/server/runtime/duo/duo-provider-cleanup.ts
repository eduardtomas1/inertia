import type { TurnProviderRuntime } from "../turns/turn-controller-types";

export async function confirmDuoProviderCleanup(
  providers: TurnProviderRuntime,
  conversationId: string,
  identity: { runId: string; turnId: string },
  options: {
    cleanupAlreadyConfirmed: boolean;
    allowStop: boolean;
  },
): Promise<"confirmed" | "unconfirmed" | "rejected"> {
  if (options.cleanupAlreadyConfirmed || !options.allowStop) {
    return providers.isRunning(conversationId) ? "rejected" : "confirmed";
  }
  try {
    const result = await providers.stopOwned(
      conversationId,
      identity,
      undefined,
    );
    if (result === "settled") return "confirmed";
    return result === "force-detached" ? "unconfirmed" : "rejected";
  } catch {
    return "unconfirmed";
  }
}
