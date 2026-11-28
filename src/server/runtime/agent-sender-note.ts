import { neutralizeUntrustedAgentText } from "./untrusted-agent-text";

export type AgentSenderNoteKind = "agent" | "scheduled";

export interface AgentSenderNoteSource {
  conversationId: string;
  title: string;
  kind?: AgentSenderNoteKind;
}

export const MAX_AGENT_SENDER_TITLE_CHARS = 120;
const MAX_AGENT_SENDER_ID_CHARS = 128;

const LEADING_SLASH_COMMAND_PATTERN = /^\/[\w:-]+(?:\s|$)/u;
const LEADING_SKILL_MENTION_PATTERN = /^\$[\w:-]+(?:\s|$)/u;
const AGENT_SENDER_NOTE_PREFIX =
  /^\[Inertia: (?:the agent in chat|scheduled task) "[^"\n\r]*" \([^)\n\r]+\) sent this message, not the user\.\](?:\r?\n|$)/u;

function sanitizeSenderTitle(title: string, kind: AgentSenderNoteKind | undefined): string {
  const withoutControls = title.replace(/[\u0000-\u001f\u007f]+/gu, " ");
  const neutralized = neutralizeUntrustedAgentText(withoutControls)
    .replace(/"/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(neutralized).slice(0, MAX_AGENT_SENDER_TITLE_CHARS).join("").trim();
  return bounded || (kind === "scheduled" ? "Untitled task" : "Untitled chat");
}

function sanitizeSenderId(conversationId: string): string {
  const cleaned = conversationId.replace(/[\u0000-\u001f\u007f()]+/gu, "").trim();
  const bounded = Array.from(cleaned).slice(0, MAX_AGENT_SENDER_ID_CHARS).join("").trim();
  return bounded || "unknown";
}

export function isLeadingCommandOrSkill(content: string): boolean {
  const trimmed = content.trimStart();
  return LEADING_SLASH_COMMAND_PATTERN.test(trimmed) || LEADING_SKILL_MENTION_PATTERN.test(trimmed);
}

export function hasAgentSenderNote(content: string): boolean {
  return AGENT_SENDER_NOTE_PREFIX.test(content.trimStart());
}

export function agentSenderNoteLine(source: AgentSenderNoteSource): string {
  const safeTitle = sanitizeSenderTitle(source.title, source.kind);
  const safeId = sanitizeSenderId(source.conversationId);
  const subject = source.kind === "scheduled"
    ? `scheduled task "${safeTitle}" (${safeId})`
    : `the agent in chat "${safeTitle}" (${safeId})`;
  return `[Inertia: ${subject} sent this message, not the user.]`;
}

/**
 * Attributes agent- and schedule-originated prompts in provider-visible text
 * (`b0b2c4f95`), leaving leading `/command` and `$skill` mentions untouched
 * and never double-prefixing an already attributed message.
 */
export function withAgentSenderNote(
  content: string,
  source: AgentSenderNoteSource,
): string {
  if (hasAgentSenderNote(content) || isLeadingCommandOrSkill(content)) {
    return content;
  }
  return `${agentSenderNoteLine(source)}\n\n${content}`;
}
