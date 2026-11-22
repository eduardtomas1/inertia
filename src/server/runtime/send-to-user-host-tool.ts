import { z } from "zod";

import type { AgentTurn, ChatMessage, Conversation, RuntimeMutationEvent } from "../../shared/contracts";
import {
  SEND_TO_USER_MAX_LENGTH,
  SEND_TO_USER_MAX_PER_TURN,
  SEND_TO_USER_TOOL_NAME,
  sendToUserCodePoints,
} from "../../shared/send-to-user";
import type { RuntimeStore } from "../database";
import { SentToUserLimitReachedError, SentToUserTurnInactiveError } from "../persistence/sent-to-user-repository";
import type {
  ProviderHostToolCall,
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";
import { invalidHostToolArguments } from "./host-tool-argument-errors";

export const SEND_TO_USER_RESULT_MESSAGE = "Shown to the user. Don't repeat it in your reply.";

// At least one character that is neither whitespace nor NUL, and no NUL at all:
// the same rule as the runtime validator, so a schema-valid message is accepted.
const MESSAGE_PATTERN = "^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$";

export const sendToUserInputSchema = z.object({
  message: z.string()
    .min(1, { abort: true })
    .refine((value) => !value.includes("\u0000"), "must not contain NUL characters")
    .refine((value) => value.trim().length > 0, "must not be only whitespace")
    .refine(
      (value) => sendToUserCodePoints(value) <= SEND_TO_USER_MAX_LENGTH,
      `at most ${SEND_TO_USER_MAX_LENGTH} characters`,
    ),
}).strict();

export const SEND_TO_USER_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: SEND_TO_USER_TOOL_NAME,
  description: "Show the user a Markdown message in this chat, exactly as written, before your turn ends. Use it for content the user must read in full mid-turn, such as a draft, a code block, or what a question you are about to ask refers to. Don't repeat it in your reply.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      message: {
        type: "string",
        minLength: 1,
        maxLength: SEND_TO_USER_MAX_LENGTH,
        pattern: MESSAGE_PATTERN,
        description: "Markdown, shown verbatim.",
      },
    },
    required: ["message"],
  },
  inputValidator: sendToUserInputSchema,
  readOnly: true,
  destructive: false,
  idempotent: false,
  // Claude Code defers MCP tools behind its tool search; a model that cannot
  // see this tool writes the message as pre-tool text, which arrives summarized.
  alwaysLoad: true,
};

export interface SendToUserHostToolDependencies {
  store: Pick<RuntimeStore, "sentToUser">;
  broadcast(event: RuntimeMutationEvent): void;
}

interface SendToUserSource {
  conversation: Conversation;
  turn: AgentTurn;
}

function failure(code: string, message: string): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code, message } }) };
}

/** Shows one agent-authored Markdown message in the caller's own active turn. */
export class SendToUserHostTool {
  constructor(private readonly dependencies: SendToUserHostToolDependencies) {}

  invoke(source: SendToUserSource, call: ProviderHostToolCall): ProviderHostToolResult {
    const parsed = sendToUserInputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return failure("invalid_arguments", invalidHostToolArguments(
        SEND_TO_USER_TOOL_NAME,
        SEND_TO_USER_TOOL_DEFINITION.inputSchema,
        call.arguments,
        parsed.error,
      ));
    }
    if (call.signal.aborted) return failure("call_cancelled", "The message was not shown because the call was cancelled.");
    let message: ChatMessage;
    try {
      message = this.dependencies.store.sentToUser.create({
        conversationId: source.conversation.id,
        runId: source.turn.runId,
        turnId: source.turn.id,
        content: parsed.data.message,
      });
    } catch (error) {
      if (error instanceof SentToUserTurnInactiveError) return failure("turn_not_active", error.message);
      if (error instanceof SentToUserLimitReachedError) {
        return failure(
          "message_limit_reached",
          `This turn already showed its maximum of ${SEND_TO_USER_MAX_PER_TURN} messages to the user. Put anything else in your written reply.`,
        );
      }
      return failure("message_not_saved", "Inertia could not save the message. Put it in your written reply instead.");
    }
    try {
      this.dependencies.broadcast({ type: "conversation.message.persisted", message });
    } catch {
      // The message is saved; clients pick it up from the next conversation detail load.
    }
    return { success: true, text: JSON.stringify({ sent: true, message: SEND_TO_USER_RESULT_MESSAGE }) };
  }
}
