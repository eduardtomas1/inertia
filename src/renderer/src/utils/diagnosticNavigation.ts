import { parseSettingsTarget, type SettingsTarget, type SettingsTargetInput } from "../lib/settingsTarget";

export type DiagnosticNavigation = SettingsTarget | { conversationId: string };
export const DIAGNOSTIC_NAVIGATION_EVENT = "inertia:open-diagnostics-context";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseDiagnosticNavigation(value: unknown): DiagnosticNavigation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ("conversationId" in value) return typeof value.conversationId === "string" && uuid.test(value.conversationId)
    && Object.keys(value).length === 1 ? { conversationId: value.conversationId } : null;
  return parseSettingsTarget(value);
}

export function navigateDiagnosticContext(target: DiagnosticNavigation | SettingsTargetInput): void {
  const safe = parseDiagnosticNavigation(target);
  if (safe) window.dispatchEvent(new CustomEvent(DIAGNOSTIC_NAVIGATION_EVENT, { detail: safe }));
}

export function diagnosticErrorReference(message: string): { message: string; incidentId?: string } {
  const match = / \[incident:([0-9a-f-]{36})\]$/iu.exec(message);
  return match && uuid.test(match[1]!) ? { message: message.slice(0, match.index), incidentId: match[1] } : { message };
}
