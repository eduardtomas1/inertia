import { z } from "zod";

import type { Conversation } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type {
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";
import type { TurnController } from "./turns/turn-controller";

export const AGENT_THREAD_WAIT_TOOL_NAME = "inertia_wait_for_conversation";

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
    "Wait for a chat created by this parent chat to settle, then return its persisted lifecycle status like inertia_get_conversation_status.",
    "Returns as soon as the chat has no active turn (outcome \"settled\": status idle, completed, or failed, with the latest turn completed, failed, cancelled, or interrupted) or needs the user's input (outcome \"needs-input\"), or after timeoutMs with the current status and timedOut: true.",
    `timeoutMs is ${MIN_AGENT_THREAD_WAIT_MS.toLocaleString("en")} to ${MAX_AGENT_THREAD_WAIT_MS.toLocaleString("en")} milliseconds (default ${DEFAULT_AGENT_THREAD_WAIT_MS.toLocaleString("en")}); it is capped because provider tool calls time out after about 30 seconds.`,
    "To wait longer, call this tool again after a timeout instead of asking for a longer wait.",
    "It does not return transcript content; read the result with inertia_get_latest_result once the chat settles.",
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

export interface ManagedConversationStatusDependencies {
  store: Pick<RuntimeStore, "latestAgentTurnForConversation">;
  turns: Pick<TurnController, "isActive">;
}

/** The persisted lifecycle projection both the status and wait tools return. */
export function managedConversationStatus(
  dependencies: ManagedConversationStatusDependencies,
  target: Conversation,
): Record<string, unknown> {
  const latest = dependencies.store.latestAgentTurnForConversation(target.id);
  return {
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
}

export interface AgentThreadWaitDependencies extends ManagedConversationStatusDependencies {
  /** Re-checks the exact calling turn; throws once it is no longer active. */
  assertSource(): Conversation;
  /** Resolves a chat this caller manages directly; throws otherwise. */
  managedTarget(source: Conversation, conversationId: string): Conversation;
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
  const parsed = waitSchema.safeParse(args);
  if (!parsed.success) {
    return failure(
      "invalid_arguments",
      `Pass the conversationId of a chat this chat created and an optional integer timeoutMs from ${MIN_AGENT_THREAD_WAIT_MS} to ${MAX_AGENT_THREAD_WAIT_MS}.`,
    );
  }
  const input = parsed.data;
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
      return {
        success: true,
        text: JSON.stringify({
          ...managedConversationStatus(dependencies, target),
          outcome: outcome ?? "timeout",
          timedOut: outcome === null,
        }),
      };
    }
    await pause(Math.min(AGENT_THREAD_WAIT_POLL_MS, remaining), signal);
  }
}
