import { z } from "zod";

import type { Conversation } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { ProviderHostToolDefinition, ProviderHostToolResult } from "../provider/contracts";
import { boundedUntrustedAgentText } from "./untrusted-agent-text";
import { boundedSubagentText } from "../provider/subagent-trace";
import { scrubCommandSecrets } from "../provider/command-secrets";

const schema = z.object({ conversationId: z.string().uuid(),
  afterRevision: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict();

export const FORK_HISTORY_TOOL: ProviderHostToolDefinition = {
  name: "inertia_fork_history", readOnly: true,
  description: "Read immutable history inherited by a fork in this project. Returns source attribution and a cursor for the next bounded text segment. Continue with that cursor until null.",
  inputValidator: schema,
  inputSchema: { type: "object", additionalProperties: false, required: ["conversationId"], properties: {
    conversationId: { type: "string", format: "uuid" }, afterRevision: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0, maximum: 1_000_000 },
  } },
};

export function readForkHistoryTool(store: RuntimeStore, caller: Conversation, input: unknown): ProviderHostToolResult {
  const request = schema.parse(input);
  const target = store.conversation(request.conversationId);
  if (target.projectId !== caller.projectId) throw new Error("Fork history is scoped to this project.");
  const afterRevision = request.afterRevision ?? 0;
  const offset = request.offset ?? 0;
  const page = store.orchestration.forks.history(target.id, afterRevision, 1);
  const part = page.parts[0];
  if (!part) return { success: true, text: JSON.stringify({ conversationId: target.id, item: null, cursor: null }) };
  // A command or error is redacted like the chat's own commands before the usual scrub, over the whole item so
  // a secret split across parts is still recognized: the first part carries it all, later parts are empty.
  const redact = part.kind === "command" || part.kind === "error";
  const whole = redact && part.parts > 1
    ? part.part === 0 ? store.orchestration.forks.itemText(target.id, part.ordinal, part.parts) ?? "" : ""
    : part.text;
  const raw = redact ? scrubCommandSecrets(whole.replace(/\0/gu, "")) : whole;
  const sanitized = boundedUntrustedAgentText(boundedSubagentText(raw, raw.length) ?? "", 524_288);
  const characters = Array.from(sanitized.text);
  if (offset > characters.length) throw new Error("The fork history cursor is invalid.");
  const text = characters.slice(offset, offset + 2_000).join("");
  const cursor = offset + 2_000 < characters.length
    ? { afterRevision, offset: offset + 2_000 }
    : page.next === null ? null : { afterRevision: page.next, offset: 0 };
  return { success: true, text: JSON.stringify({ conversationId: target.id,
    item: { ...part, text }, offset, cursor, historical: true, neutralized: sanitized.neutralized }) };
}
