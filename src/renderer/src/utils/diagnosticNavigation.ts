export interface DiagnosticSelection { incidentId?: string; turnId?: string; requestId?: string }
export type DiagnosticNavigation =
  | { section: "diagnostics"; selection?: DiagnosticSelection }
  | { section: "providers" | "discord" }
  | { conversationId: string };
export const DIAGNOSTIC_NAVIGATION_EVENT = "inertia:open-diagnostics-context";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseDiagnosticNavigation(value: unknown): DiagnosticNavigation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ("conversationId" in value) return typeof value.conversationId === "string" && uuid.test(value.conversationId)
    && Object.keys(value).length === 1 ? { conversationId: value.conversationId } : null;
  if (!("section" in value)) return null;
  if (value.section === "providers" || value.section === "discord") return { section: value.section };
  if (value.section !== "diagnostics") return null;
  const selection: DiagnosticSelection = {};
  if ("selection" in value && value.selection !== undefined) {
    if (!value.selection || typeof value.selection !== "object" || Array.isArray(value.selection)) return null;
    for (const [key, id] of Object.entries(value.selection)) {
      if (!["incidentId", "turnId", "requestId"].includes(key) || typeof id !== "string" || !uuid.test(id)) return null;
      Object.assign(selection, { [key]: id });
    }
  }
  return { section: "diagnostics", selection };
}

export function navigateDiagnosticContext(target: DiagnosticNavigation): void {
  const safe = parseDiagnosticNavigation(target);
  if (safe) window.dispatchEvent(new CustomEvent(DIAGNOSTIC_NAVIGATION_EVENT, { detail: safe }));
}

export function diagnosticErrorReference(message: string): { message: string; incidentId?: string } {
  const match = / \[incident:([0-9a-f-]{36})\]$/iu.exec(message);
  return match && uuid.test(match[1]!) ? { message: message.slice(0, match.index), incidentId: match[1] } : { message };
}
