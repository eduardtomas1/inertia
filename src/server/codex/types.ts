import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderRateLimit } from "../../shared/contracts";

export type CodexApprovalDecision = "approve" | "deny" | "cancel";
export type CodexApprovalKind = "command" | "file-change" | "permissions";

export interface CodexApprovalNetworkScope {
  host: string;
  protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
}

export interface CodexApprovalPermissionRoot {
  path: string;
  access: "read" | "write";
}

export interface CodexApprovalRequest {
  requestId: string;
  kind: CodexApprovalKind;
  title: string;
  detail?: string;
  command?: string;
  cwd?: string;
  reason?: string;
  networkScope?: CodexApprovalNetworkScope;
  permissionRoots: CodexApprovalPermissionRoot[];
  availableDecisions: CodexApprovalDecision[];
}

export interface CodexInputOption {
  label: string;
  description: string;
}

export interface CodexInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: CodexInputOption[];
}

export interface CodexInputRequest {
  requestId: string;
  questions: CodexInputQuestion[];
  autoResolutionMs: number | null;
}

export interface CodexPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export interface CodexUsageSnapshot {
  usedTokens: number | null;
  totalProcessedTokens: number | null;
  totalProcessedScope: "thread";
  maxTokens: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  compactsAutomatically: null;
}

export interface CodexAppServerOptions {
  executable: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  sessionId?: string;
  imagePaths?: readonly string[];
  planMode: boolean;
  access: "supervised" | "auto-edit" | "full";
  onText?: (text: string) => void;
  onActivity?: (kind: "system" | "turn" | "tool" | "command" | "reasoning", phase: "started" | "completed" | "failed" | "info", label: string) => void;
  onSession?: (sessionId: string) => void;
  onStatus?: (status: "running") => void;
  onApproval?: (request: CodexApprovalRequest) => void;
  onApprovalResolved?: (requestId: string, decision: CodexApprovalDecision | "cancelled") => void;
  onInputRequest?: (request: CodexInputRequest) => void;
  onInputResolved?: (requestId: string) => void;
  onPlan?: (explanation: string | null, steps: CodexPlanStep[]) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: CodexUsageSnapshot) => void;
  onRateLimits?: (rateLimits: ProviderRateLimit[], complete: boolean) => void;
}

export interface CodexAppServerResult {
  status: "completed" | "failed" | "cancelled";
  sessionId?: string;
  text: string;
  textTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostic?: string;
  compatibilityError?: "full-access-unsupported";
}

export interface CodexAppServerRun {
  child: ChildProcessWithoutNullStreams;
  result: Promise<CodexAppServerResult>;
  cancel: (force?: boolean) => void;
  respondToApproval: (requestId: string, decision: CodexApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
}
