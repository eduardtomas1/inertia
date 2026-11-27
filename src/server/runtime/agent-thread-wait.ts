import { z } from "zod";

import type { AgentInputRequest, Conversation } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type {
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";
import { MAX_PROVIDER_HOST_TOOL_RESULT_BYTES } from "../../shared/provider-host-tools";
import { withHostToolAllowance } from "../provider/host-tool-runtime";
import type { TurnController } from "./turns/turn-controller";
import { pendingQuestionStatus } from "./managed-child-questions";

export const AGENT_THREAD_WAIT_TOOL_NAME = "inertia_wait_for_conversation";
export const DELEGATED_WAIT_TIMEOUT_NEXT =
  "This delegated task will wake you automatically when it finishes. Do not poll in a loop; end your turn and wait for its completion message.";

/**
 * OpenCode's MCP client gives each host-tool call 30 seconds
 * (`host-tool-mcp-config.ts`), and the HTTP bridge and stdio proxy add their
 * own deadlines on top. A wait therefore stays well below that and the model
 * loops for longer waits instead of holding one call open.
 */
export const MIN_AGENT_THREAD_WAIT_MS = 1_000;
export const MAX_AGENT_THREAD_WAIT_MS = 20_000;
export const DEFAULT_AGENT_THREAD_WAIT_MS = 15_000;
/** Each poll is a few indexed reads outside any transaction. */
export const AGENT_THREAD_WAIT_POLL_MS = 250;

const waitSchema = z.object({
  conversationId: z.string().uuid(),
  timeoutMs: z.number().int()
    .min(MIN_AGENT_THREAD_WAIT_MS)
    .max(MAX_AGENT_THREAD_WAIT_MS)
    .optional(),
}).strict();

export const AGENT_THREAD_WAIT_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: AGENT_THREAD_WAIT_TOOL_NAME,
  description: [
    "Wait for a chat this chat created to settle or need input, then return its status like inertia_get_conversation_status, plus outcome and timedOut.",
    `timeoutMs: ${MIN_AGENT_THREAD_WAIT_MS.toLocaleString("en")} to ${MAX_AGENT_THREAD_WAIT_MS.toLocaleString("en")} (default ${DEFAULT_AGENT_THREAD_WAIT_MS.toLocaleString("en")}); after a timeout, call again, which doesn't use the allowance.`,
    "Results report remainingToolCalls.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      conversationId: { type: "string", format: "uuid" },
      timeoutMs: {
        type: "integer",
        minimum: MIN_AGENT_THREAD_WAIT_MS,
        maximum: MAX_AGENT_THREAD_WAIT_MS,
        default: DEFAULT_AGENT_THREAD_WAIT_MS,
      },
    },
    required: ["conversationId"],
  },
  inputValidator: waitSchema,
  readOnly: true,
};

/**
 * Room the pending questions leave in a status or wait result for what is
 * added around them: the pendingQuestions, omittedQuestions and next keys,
 * the wait's outcome and timedOut, and the runtime's remainingToolCalls.
 */
const STATUS_RESPONSE_RESERVE_BYTES = 512;

export interface ManagedConversationStatusDependencies {
  store: Pick<RuntimeStore, "latestAgentTurnForConversation">;
  turns: Pick<TurnController, "isActive">;
  /** The provider questions awaiting an answer, keyed like the turn controller's map. */
  pendingInputs?: ReadonlyMap<string, AgentInputRequest>;
}

/**
 * The persisted lifecycle projection both the status and wait tools return,
 * plus the chat's pending questions another agent may answer.
 */
export function managedConversationStatus(
  dependencies: ManagedConversationStatusDependencies,
  target: Conversation,
): Record<string, unknown> {
  const latest = dependencies.store.latestAgentTurnForConversation(target.id);
  const status = {
    conversationId: target.id,
    status: target.status,
    active: dependencies.turns.isActive(target.id),
    archived: target.archivedAt !== null,
    latestTurn: latest ? {
      turnId: latest.id,
      status: latest.status,
      terminalReason: latest.terminalReason,
      requestedAt: latest.requestedAt,
      startedAt: latest.startedAt,
      completedAt: latest.completedAt,
    } : null,
  };
  // The questions get what the whole result leaves, so the runtime never cuts the JSON short.
  const budget = MAX_PROVIDER_HOST_TOOL_RESULT_BYTES
    - Buffer.byteLength(JSON.stringify(status), "utf8")
    - STATUS_RESPONSE_RESERVE_BYTES;
  return { ...status, ...pendingQuestionStatus(dependencies.pendingInputs, target.id, target.status === "needs-input", budget) };
}

export interface AgentThreadWaitDependencies extends ManagedConversationStatusDependencies {
  /** Re-checks the exact calling turn; throws once it is no longer active. */
  assertSource(): Conversation;
  /** Resolves a chat this caller manages directly; throws otherwise. */
  managedTarget(source: Conversation, conversationId: string): Conversation;
  /** Whether the managed child currently has an armed automatic completion wake (`83edd5e72`). */
  hasArmedDelegationWake?: (childConversationId: string) => boolean;
}

type WaitOutcome = "settled" | "needs-input";

function outcomeFor(
  dependencies: AgentThreadWaitDependencies,
  target: Conversation,
): WaitOutcome | null {
  if (target.status === "needs-input") return "needs-input";
  return dependencies.turns.isActive(target.id) ? null : "settled";
}

function failure(code: string, message: string): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code, message } }) };
}

function cancelled(): ProviderHostToolResult {
  return failure("call_cancelled", "The host tool call was cancelled.");
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Waits for a managed child chat by polling its persisted status at a bounded
 * interval. No database transaction or lock is held between polls, and the
 * caller's exact turn is checked again before anything is returned.
 */
export async function waitForManagedConversation(
  dependencies: AgentThreadWaitDependencies,
  args: unknown,
  signal: AbortSignal,
): Promise<ProviderHostToolResult> {
  // A ZodError reaches the manager, which reports it like every chat tool.
  const input = waitSchema.parse(args);
  const timeoutMs = input.timeoutMs ?? DEFAULT_AGENT_THREAD_WAIT_MS;
  // Monotonic, so a wall-clock change cannot stretch the wait.
  const deadline = performance.now() + timeoutMs;
  while (true) {
    if (signal.aborted) return cancelled();
    // Every poll re-checks the caller's exact turn and its authority over the
    // child, so a turn that settled while this call waited gets no result.
    const target = dependencies.managedTarget(
      dependencies.assertSource(),
      input.conversationId,
    );
    const outcome = outcomeFor(dependencies, target);
    const remaining = deadline - performance.now();
    if (outcome !== null || remaining <= 0) {
      const timedOut = outcome === null;
      const delegatedWakeHint = timedOut && dependencies.hasArmedDelegationWake?.(target.id) === true
        ? DELEGATED_WAIT_TIMEOUT_NEXT
        : undefined;
      // Polling a long-running child must not use up the caller's allowance,
      // so only a wait that observed a change is charged.
      return withHostToolAllowance({
        success: true,
        text: JSON.stringify({
          ...managedConversationStatus(dependencies, target),
          outcome: outcome ?? "timeout",
          timedOut,
          ...(delegatedWakeHint ? { next: delegatedWakeHint } : {}),
        }),
      }, timedOut ? "uncharged" : "charged");
    }
    await pause(Math.min(AGENT_THREAD_WAIT_POLL_MS, remaining), signal);
  }
}
