import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProviderRateLimit } from "../../shared/contracts";
import type { ProviderSkillInput } from "../../shared/contracts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlanStep,
} from "../provider/interactions";
import type {
  CodexResponsesHarnessConfiguration,
  ProviderActivityEvent,
  ProviderGoalSnapshot,
  ProviderRunFailure,
} from "../provider/contracts";
import type { ProcessTreeTerminator } from "../process-lifecycle";

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
  modelProvider?: CodexResponsesHarnessConfiguration;
  reasoningEffort?: string;
  sessionId?: string;
  imagePaths?: readonly string[];
  skills?: readonly Extract<
    ProviderSkillInput,
    { source: "codex-native" }
  >[];
  planMode: boolean;
  access: "supervised" | "auto-edit" | "full";
  /** Testable bound for one JSON-RPC response; defaults to 30 seconds. */
  rpcTimeoutMs?: number;
  /**
   * Test seam that may shorten, but never extend, the bounded wait for child
   * turn outcomes after the parent completes.
   */
  subagentDrainTimeoutMs?: number;
  /** Test-only transport bounds; production callers use the hardened defaults. */
  protocolLimits?: {
    maxFrameBytes: number;
    maxProtocolBytes: number;
  };
  /** Test seam for the owned App Server process-tree lifecycle. */
  terminateProcessTree?: ProcessTreeTerminator;
  onText?: (text: string) => void;
  onActivity?: (
    kind: "system" | "turn" | "tool" | "command" | "reasoning",
    phase: "started" | "completed" | "failed" | "info",
    label: string,
    detail?: Pick<ProviderActivityEvent, "activityId" | "detail">,
  ) => void;
  onSession?: (sessionId: string) => void;
  onStatus?: (status: "running") => void;
  onApproval?: (request: AgentApprovalRequest) => void;
  onApprovalResolved?: (requestId: string, decision: AgentApprovalDecision | "cancelled") => void;
  onInputRequest?: (request: AgentInputRequest) => void;
  onInputResolved?: (requestId: string) => void;
  onPlan?: (explanation: string | null, steps: AgentPlanStep[]) => void;
  onGoalUpdated?: (threadId: string, goal: ProviderGoalSnapshot) => void;
  onGoalCleared?: (threadId: string) => void;
  onReasoning?: (text: string) => void;
  onUsage?: (usage: CodexUsageSnapshot) => void;
  onRateLimits?: (rateLimits: ProviderRateLimit[], complete: boolean) => void;
  onSubagent?: (event: {
    sequence: number;
    providerTaskId: string | null;
    providerAgentId: string | null;
    parentProviderAgentId: string | null;
    parentProviderToolUseId: string | null;
    providerToolUseId: string | null;
    providerRole: string | null;
    providerName: string | null;
    providerStatus: string | null;
    status: "queued" | "spawned" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown" | "lost";
    isLive: boolean;
    description: string | null;
    progress: string | null;
    result: string | null;
  }) => void;
}

export interface CodexAppServerResult {
  status: "completed" | "failed" | "cancelled";
  sessionId?: string;
  text: string;
  textTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  diagnostic?: string;
  failure?: ProviderRunFailure;
  compatibilityError?: "full-access-unsupported";
  continuationError?: "stale-provider-session";
}

export interface CodexAppServerRun {
  child: ChildProcessWithoutNullStreams;
  result: Promise<CodexAppServerResult>;
  cancel: (force?: boolean) => void;
  respondToApproval: (requestId: string, decision: AgentApprovalDecision) => boolean;
  respondToInput: (requestId: string, answers: Record<string, string[]>) => boolean;
  steer?: (content: string) => Promise<boolean>;
}
