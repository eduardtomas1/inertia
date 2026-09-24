import type { JsonObject } from "./protocol";

export const MAX_PRE_RESPONSE_TURN_NOTIFICATIONS = 256;

interface HeldTurnNotification {
  method: string;
  turnId: string;
  params: JsonObject;
}

/**
 * Codex writes turn/started (and a short turn's later notifications) from its
 * event loop and the turn/start response from the request handler, so the
 * notification can reach stdout first. While the requested turn id is still
 * unknown these turn-scoped notifications are held rather than dropped; the
 * ones that belong to the returned turn are replayed and the rest discarded.
 */
export class PreResponseTurnNotifications {
  private readonly held: HeldTurnNotification[] = [];

  /**
   * Holds the notification, or returns false once the bound is reached. The
   * caller then fails the run: evicting the oldest entry would drop
   * turn/started and leave the replayed turn without its lifecycle markers.
   */
  hold(method: string, turnId: string, params: JsonObject): boolean {
    if (this.held.length >= MAX_PRE_RESPONSE_TURN_NOTIFICATIONS) return false;
    this.held.push({ method, turnId, params });
    return true;
  }

  /** Removes every held notification and returns those of the given turn. */
  take(turnId: string): HeldTurnNotification[] {
    return this.held.splice(0).filter((notification) => notification.turnId === turnId);
  }
}
