import type Database from "better-sqlite3";

import type { ProviderId } from "../../shared/contracts";
import type { ConversationContextExcerpt, UnfinishedTurnState } from "../../shared/conversation-context";
import type { AgentTurnStatus } from "../../shared/turn-lifecycle";
import { PROVIDER_INFO } from "../provider/catalog";
import { scrubCommandSecrets } from "../provider/command-secrets";
import { boundedSubagentText } from "../provider/subagent-trace";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";
import { byteLength } from "./bounded-message-text";
import { recordedCommandExitCode } from "./command-exit-code";

export const MAX_TURN_AGENT_LABEL_LENGTH = 120;
export const MAX_TURN_COMMANDS_BYTES = 200;

const MAX_TURN_COMMANDS = 3;
const MAX_TURN_COMMAND_LENGTH = 60;
const COMMAND_ROWS = 12;
const GENERIC_COMMAND_TITLES = new Set(["Bash", "Command"]);

export interface TurnContextFacts {
  agent: string;
  state: UnfinishedTurnState | null;
}

function oneLine(value: string, maxLength: number): string {
  return neutralizeUntrustedAgentText(value.replace(/\s+/gu, " ").trim()).slice(0, maxLength);
}

export function turnAgentLabel(providerId: ProviderId, model: string): string {
  const name = PROVIDER_INFO[providerId]?.name ?? providerId;
  return oneLine(model && model !== "provider-default" ? `${name} ${model}` : name, MAX_TURN_AGENT_LABEL_LENGTH);
}

export function unfinishedTurnState(status: AgentTurnStatus): UnfinishedTurnState | null {
  if (status === "completed") return null;
  if (status === "cancelled") return "cancelled";
  return status === "failed" || status === "interrupted" ? "failed" : "running";
}

export function turnContextFactsReader(
  database: Database.Database,
): (turnId: string | null) => TurnContextFacts | null {
  const statement = database.prepare(`
    SELECT provider_id, model, status FROM agent_turns WHERE id = ?
  `);
  const cache = new Map<string, TurnContextFacts | null>();
  return (turnId) => {
    if (turnId === null) return null;
    if (!cache.has(turnId)) {
      const row = statement.get(turnId) as
        | { provider_id: ProviderId; model: string; status: AgentTurnStatus }
        | undefined;
      cache.set(turnId, row
        ? { agent: turnAgentLabel(row.provider_id, row.model), state: unfinishedTurnState(row.status) }
        : null);
    }
    return cache.get(turnId)!;
  };
}

function commandText(title: string, detail: string | null): string | null {
  const section = /^Command:\n([^\n]+)/u.exec(detail ?? "")?.[1];
  const scrubbed = boundedSubagentText(
    section ?? (GENERIC_COMMAND_TITLES.has(title) ? null : title),
    4_096,
  );
  if (!scrubbed) return null;
  const line = oneLine(scrubCommandSecrets(scrubbed), MAX_TURN_COMMAND_LENGTH + 1);
  return line.length > MAX_TURN_COMMAND_LENGTH ? `${line.slice(0, MAX_TURN_COMMAND_LENGTH - 1)}…` : line;
}

function commandOutcome(providerId: ProviderId, status: string, detail: string | null): string {
  const exitCode = recordedCommandExitCode(providerId, status, detail);
  if (exitCode !== null) return `exit ${exitCode}`;
  return status === "completed" ? "ok" : status;
}

export function lastTurnCommands(database: Database.Database, turnId: string): string[] {
  const providerId = (database.prepare("SELECT provider_id FROM agent_turns WHERE id = ?")
    .get(turnId) as { provider_id: ProviderId } | undefined)?.provider_id;
  if (!providerId) return [];
  const rows = database.prepare(`
    SELECT title, detail, status FROM activities
    WHERE turn_id = ? AND kind = 'command'
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(turnId, COMMAND_ROWS) as Array<{ title: string; detail: string | null; status: string }>;
  const commands: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const text = commandText(row.title, row.detail);
    if (!text) continue;
    const line = `${text} (${commandOutcome(providerId, row.status, row.detail)})`;
    const lineBytes = byteLength(JSON.stringify(line)) + 1;
    if (bytes + lineBytes > MAX_TURN_COMMANDS_BYTES) break;
    commands.unshift(line);
    bytes += lineBytes;
    if (commands.length === MAX_TURN_COMMANDS) break;
  }
  return commands;
}

export function providerHandoffReason(
  database: Database.Database,
  conversationId: string,
  before: string,
  providerId: ProviderId,
): string | null {
  const turn = database.prepare(`
    SELECT turn.provider_id, turn.status,
      EXISTS(SELECT 1 FROM usage_limited_turns AS limited WHERE limited.turn_id = turn.id) AS limited
    FROM agent_turns AS turn
    WHERE turn.conversation_id = ? AND turn.provider_id <> ? AND turn.requested_at <= ?
      AND turn.association = 'authoritative'
    ORDER BY turn.requested_at DESC, turn.rowid DESC
    LIMIT 1
  `).get(conversationId, providerId, before) as
    | { provider_id: ProviderId; status: AgentTurnStatus; limited: 0 | 1 }
    | undefined;
  if (!turn) return null;
  const name = PROVIDER_INFO[turn.provider_id]?.name ?? turn.provider_id;
  if (turn.limited === 1) return `from ${name} after it reached its usage limit`;
  return unfinishedTurnState(turn.status) === "failed"
    ? `from ${name} after its last turn failed`
    : `from ${name} by the user's choice`;
}

export function finalTurnCommands(
  database: Database.Database,
  excerpts: readonly ConversationContextExcerpt[],
): string[] {
  const finalTurnId = [...excerpts].reverse().find(({ sourceTurnId }) => sourceTurnId !== null)?.sourceTurnId;
  return finalTurnId ? lastTurnCommands(database, finalTurnId) : [];
}
