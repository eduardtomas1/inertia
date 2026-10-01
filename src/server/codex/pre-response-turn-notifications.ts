import type { JsonObject, RpcId } from "./protocol";

export const MAX_PRE_RESPONSE_TURN_NOTIFICATIONS = 256;

interface HeldTurnNotification {
  method: string;
  turnId: string;
  params: JsonObject;
  requestId?: RpcId;
}

/**
 * Codex writes turn/started (and a short turn's later notifications) from its
 * event loop and the turn/start response from the request handler, so the
 * notification can reach stdout first. While the requested turn id is still
 * unknown these turn-scoped notifications are held rather than dropped.
 * Matching notifications are replayed and the rest discarded. Approval
 * requests retain their position too, but mismatches are replayed for an
 * explicit rejection rather than leaving their RPC unanswered.
 */
export class PreResponseTurnNotifications {
  private readonly held: HeldTurnNotification[] = [];

  /**
   * Holds the notification, or returns false once the bound is reached. The
   * caller then fails the run: evicting the oldest entry would drop
   * turn/started and leave the replayed turn without its lifecycle markers.
   */
  hold(method: string, turnId: string, params: JsonObject, requestId?: RpcId): boolean {
    if (this.held.length >= MAX_PRE_RESPONSE_TURN_NOTIFICATIONS) return false;
    this.held.push({ method, turnId, params, ...(requestId !== undefined ? { requestId } : {}) });
    return true;
  }

  /** Drains matching notifications and every request in their wire order. */
  take(turnId: string): HeldTurnNotification[] {
    return this.held.splice(0).filter((notification) =>
      notification.turnId === turnId || notification.requestId !== undefined);
  }

  removeRequest(requestId: RpcId): void {
    const index = this.held.findIndex((notification) => notification.requestId === requestId);
    if (index >= 0) this.held.splice(index, 1);
  }

  clear(): void {
    this.held.length = 0;
  }
}
