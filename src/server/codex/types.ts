import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderRateLimit } from "../../shared/contracts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlanStep,
} from "../provider/interactions";

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
  onApproval?: (request: AgentApprovalRequest) => void;
  onApprovalResolved?: (requestId: string, decision: AgentApprovalDecision | "cancelled") => void;
  onInputRequest?: (request: AgentInputRequest) => void;
  onInputResolved?: (requestId: string) => void;
  onPlan?: (explanation: string | null, steps: AgentPlanStep[]) => void;
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
  respondToApproval: (requestId: string, decision: AgentApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
}
