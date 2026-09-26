import type { JsonObject } from "./protocol";

const GATEWAY_OAUTH_STATUSES = ["notReady", "started", "succeeded", "failed"] as const;

/** Reviewed against Codex rust-v0.157.1 GatewayOAuthChangedNotification.
 * Inertia does not initiate gateway login. authUrl is an authorization handoff
 * and error can contain provider details: validate shape, then discard both.
 * The transport's existing frame limit bounds these unretained strings.
 */
export function validCodexGatewayOAuthNotification(params: JsonObject): boolean {
  return typeof params.providerId === "string" && params.providerId.length > 0 && params.providerId.length <= 512
    && (params.authUrl === null || typeof params.authUrl === "string")
    && (params.error === null || typeof params.error === "string")
    && typeof params.status === "string"
    && GATEWAY_OAUTH_STATUSES.some((status) => status === params.status);
}
