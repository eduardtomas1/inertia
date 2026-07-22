import type {
  ProviderActivityKind,
  ProviderActivityPhase,
  ProviderEvent,
  ProviderId,
  ProviderRunCallbacks,
  ProviderRunStatus,
  ProviderUsageEvent,
} from "./contracts";
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexInputRequest,
  CodexPlanStep,
} from "../codex/types";

function safeCallback(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Provider execution must not be interrupted by a UI callback.
  }
}

export interface ProviderEmitter {
  event: (event: ProviderEvent) => void;
  text: (text: string) => void;
  activity: (kind: ProviderActivityKind, phase: ProviderActivityPhase, label: string) => void;
  status: (status: ProviderRunStatus, message?: string) => void;
  session: (sessionId: string) => void;
  approval: (request: CodexApprovalRequest) => void;
  approvalResolved: (requestId: string, decision: CodexApprovalDecision | "cancelled") => void;
  input: (request: CodexInputRequest) => void;
  inputResolved: (requestId: string) => void;
  plan: (explanation: string | null, steps: CodexPlanStep[]) => void;
  reasoning: (text: string) => void;
  usage: (usage: ProviderUsageEvent["usage"]) => void;
}

export function createProviderEmitter(
  providerId: ProviderId,
  conversationId: string,
  callbacks: ProviderRunCallbacks,
): ProviderEmitter {
  const event = (providerEvent: ProviderEvent): void => {
    safeCallback(() => callbacks.onEvent?.(providerEvent));
    switch (providerEvent.type) {
      case "text":
        safeCallback(() => callbacks.onText?.(providerEvent));
        break;
      case "activity":
        safeCallback(() => callbacks.onActivity?.(providerEvent));
        break;
      case "status":
        safeCallback(() => callbacks.onStatus?.(providerEvent));
        break;
      case "session":
        safeCallback(() => callbacks.onSession?.(providerEvent));
        break;
      case "approval":
        safeCallback(() => callbacks.onApproval?.(providerEvent));
        break;
      case "approval-resolved":
        safeCallback(() => callbacks.onApprovalResolved?.(providerEvent));
        break;
      case "input":
        safeCallback(() => callbacks.onInput?.(providerEvent));
        break;
      case "input-resolved":
        safeCallback(() => callbacks.onInputResolved?.(providerEvent));
        break;
      case "plan":
        safeCallback(() => callbacks.onPlan?.(providerEvent));
        break;
      case "reasoning-summary":
        safeCallback(() => callbacks.onReasoning?.(providerEvent));
        break;
      case "usage":
        safeCallback(() => callbacks.onUsage?.(providerEvent));
        break;
    }
  };

  const base = { providerId, conversationId };
  return {
    event,
    text: (text) => event({ ...base, type: "text", text }),
    activity: (kind, phase, label) => event({ ...base, type: "activity", kind, phase, label }),
    status: (status, message) => event({ ...base, type: "status", status, ...(message ? { message } : {}) }),
    session: (sessionId) => event({ ...base, type: "session", sessionId }),
    approval: (request) => event({ ...base, type: "approval", request }),
    approvalResolved: (requestId, decision) => event({ ...base, type: "approval-resolved", requestId, decision }),
    input: (request) => event({ ...base, type: "input", request }),
    inputResolved: (requestId) => event({ ...base, type: "input-resolved", requestId }),
    plan: (explanation, steps) => event({ ...base, type: "plan", explanation, steps }),
    reasoning: (text) => event({ ...base, type: "reasoning-summary", text }),
    usage: (usage) => event({ ...base, type: "usage", usage }),
  };
}
