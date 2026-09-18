export const PREVIEW_AGENT_OPERATION_PHASES = [
  "security-setup",
  "privacy-guard",
  "page-load",
  "page-freeze",
  "privacy-check",
  "nested-content-check",
  "page-snapshot",
  "screenshot-capture",
  "page-resume",
  "element-lookup",
  "page-cursor",
  "page-hover",
  "input-guard",
  "key-activation",
] as const;

export const PREVIEW_AGENT_FAILURE_CATEGORIES = ["timeout", "failed"] as const;

export type PreviewAgentOperationPhase = (typeof PREVIEW_AGENT_OPERATION_PHASES)[number];
export type PreviewAgentFailureCategory = (typeof PREVIEW_AGENT_FAILURE_CATEGORIES)[number];

export interface PreviewAgentOperationFailure {
  phase: PreviewAgentOperationPhase;
  category: PreviewAgentFailureCategory;
}

const PHASE_DESCRIPTIONS: Readonly<Record<PreviewAgentOperationPhase, string>> = {
  "security-setup": "Browser security setup",
  "privacy-guard": "privacy guard setup",
  "page-load": "page loading",
  "page-freeze": "the evidence freeze",
  "privacy-check": "the page privacy check",
  "nested-content-check": "the nested-content check",
  "page-snapshot": "the page snapshot",
  "screenshot-capture": "screenshot capture",
  "page-resume": "page resume after evidence capture",
  "element-lookup": "element lookup",
  "page-cursor": "cursor rendering",
  "page-hover": "hover delivery",
  "input-guard": "input guard setup",
  "key-activation": "key activation",
};

export function isPreviewAgentOperationPhase(value: unknown): value is PreviewAgentOperationPhase {
  return typeof value === "string"
    && (PREVIEW_AGENT_OPERATION_PHASES as readonly string[]).includes(value);
}

export function isPreviewAgentFailureCategory(value: unknown): value is PreviewAgentFailureCategory {
  return typeof value === "string"
    && (PREVIEW_AGENT_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

export function previewAgentPhaseTimeoutMessage(
  phase: PreviewAgentOperationPhase,
  timeoutMs: number,
): string {
  const seconds = Math.round(timeoutMs / 1_000);
  if (phase === "page-load") {
    return `The Browser page did not finish loading within ${seconds} seconds. Check that the local server responds, then try again.`;
  }
  return `The Browser page did not respond during ${PHASE_DESCRIPTIONS[phase]} within ${seconds} seconds. Reload the page or open it in a new Browser tab, then try again.`;
}
