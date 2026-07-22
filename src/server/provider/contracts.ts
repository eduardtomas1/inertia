import type { ThreadUsageSnapshot } from "../../shared/contracts";
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexInputRequest,
  CodexPlanStep,
} from "../codex/types";

export const PROVIDER_IDS = ["codex", "claude", "cursor", "opencode"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ProviderInteractionMode = "build" | "plan";
export type ProviderAccessMode = "full" | "supervised" | "auto-edit";
export type ProviderInstallState = "checking" | "installed" | "not-installed" | "error";
export type ProviderAuthState = "checking" | "authenticated" | "unauthenticated" | "configured" | "unknown" | "error";

export interface ProviderCapabilities {
  resume: true;
  images: true;
  nativePlanMode: boolean;
  fullAccessFlag: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  command: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderDetection {
  provider: ProviderInfo;
  available: boolean;
  version?: string;
  executable?: string;
  installState: ProviderInstallState;
  authState: ProviderAuthState;
  canRun: boolean;
  statusMessage?: string;
}

export interface ProviderDetectionOptions {
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  refreshEnvironment?: boolean;
}

interface ProviderRunRequest {
  providerId: ProviderId;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  interactionMode: ProviderInteractionMode;
  access: ProviderAccessMode;
  sessionId?: string;
  imagePaths?: readonly string[];
}

export type ProviderRunInput = ProviderRunRequest &
  (
    | { conversationId: string; threadId?: never }
    | { threadId: string; conversationId?: never }
  );

export type ProviderRunStatus =
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

interface ProviderEventBase {
  providerId: ProviderId;
  /** The caller's thread or conversation identifier, normalized to one key. */
  conversationId: string;
}

export interface ProviderTextEvent extends ProviderEventBase {
  type: "text";
  text: string;
}

export type ProviderActivityKind = "system" | "turn" | "tool" | "command" | "reasoning";
export type ProviderActivityPhase = "started" | "completed" | "failed" | "info";

export interface ProviderActivityEvent extends ProviderEventBase {
  type: "activity";
  kind: ProviderActivityKind;
  phase: ProviderActivityPhase;
  label: string;
}

export interface ProviderStatusEvent extends ProviderEventBase {
  type: "status";
  status: ProviderRunStatus;
  message?: string;
}

export interface ProviderSessionEvent extends ProviderEventBase {
  type: "session";
  sessionId: string;
}

export interface ProviderApprovalEvent extends ProviderEventBase {
  type: "approval";
  request: CodexApprovalRequest;
}

export interface ProviderApprovalResolvedEvent extends ProviderEventBase {
  type: "approval-resolved";
  requestId: string;
  decision: CodexApprovalDecision | "cancelled";
}

export interface ProviderInputEvent extends ProviderEventBase {
  type: "input";
  request: CodexInputRequest;
}

export interface ProviderInputResolvedEvent extends ProviderEventBase {
  type: "input-resolved";
  requestId: string;
}

export interface ProviderPlanEvent extends ProviderEventBase {
  type: "plan";
  explanation: string | null;
  steps: CodexPlanStep[];
}

export interface ProviderReasoningEvent extends ProviderEventBase {
  type: "reasoning-summary";
  text: string;
}

export interface ProviderUsageEvent extends ProviderEventBase {
  type: "usage";
  usage: Omit<ThreadUsageSnapshot, "conversationId" | "updatedAt">;
}

export type ProviderEvent =
  | ProviderTextEvent
  | ProviderActivityEvent
  | ProviderStatusEvent
  | ProviderSessionEvent
  | ProviderApprovalEvent
  | ProviderApprovalResolvedEvent
  | ProviderInputEvent
  | ProviderInputResolvedEvent
  | ProviderPlanEvent
  | ProviderReasoningEvent
  | ProviderUsageEvent;

export interface ProviderRunCallbacks {
  onEvent?: (event: ProviderEvent) => void;
  onText?: (event: ProviderTextEvent) => void;
  onActivity?: (event: ProviderActivityEvent) => void;
  onStatus?: (event: ProviderStatusEvent) => void;
  onSession?: (event: ProviderSessionEvent) => void;
  onApproval?: (event: ProviderApprovalEvent) => void;
  onApprovalResolved?: (event: ProviderApprovalResolvedEvent) => void;
  onInput?: (event: ProviderInputEvent) => void;
  onInputResolved?: (event: ProviderInputResolvedEvent) => void;
  onPlan?: (event: ProviderPlanEvent) => void;
  onReasoning?: (event: ProviderReasoningEvent) => void;
  onUsage?: (event: ProviderUsageEvent) => void;
}

export interface ProviderRunResult {
  providerId: ProviderId;
  conversationId: string;
  status: "completed" | "failed" | "cancelled";
  sessionId?: string;
  text: string;
  textTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export type ProviderRuntimeErrorCode = "invalid_input" | "already_running";

export class ProviderRuntimeError extends Error {
  readonly code: ProviderRuntimeErrorCode;

  constructor(code: ProviderRuntimeErrorCode, message: string) {
    super(message);
    this.name = "ProviderRuntimeError";
    this.code = code;
  }
}

export interface ProviderManagerOptions {
  commands?: Partial<Record<ProviderId, string>>;
  cancelGraceMs?: number;
}

export interface ProviderAuthLaunch {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}
