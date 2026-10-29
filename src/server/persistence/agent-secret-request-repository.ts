import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  SECRET_REQUEST_MAX_ACTIVE,
  isSecretRequestDescription,
  isSecretRequestTitle,
  isSecretRequestTtlHours,
  type SecretRequestReference,
  type SecretRequestStatus,
} from "../../shared/agent-secrets";
import {
  SECRET_REQUEST_MAX_PENDING_PER_CONVERSATION,
  SECRET_REQUEST_MAX_PER_TURN,
  isSecretRequestFileName,
  isSecretRequestProviderId,
  secretRequestPlaceholderText,
} from "../../node/agent-secrets";
import type { AgentTurn, ChatMessage } from "../../shared/contracts";
import type { ProviderId } from "../../shared/provider";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { requireTimestamp } from "./codecs";
import type { CreateMessageOptions } from "./types";

export interface AgentSecretRequestRecord {
  id: string;
  conversationId: string;
  turnId: string;
  runId: string;
  messageId: string;
  providerId: ProviderId;
  title: string;
  description: string;
  fileName: string;
  fileToken: string | null;
  ttlHours: number;
  status: SecretRequestStatus;
  vaulted: boolean;
  createdAt: string;
  answeredAt: string | null;
  expiresAt: string | null;
}

export interface CreateAgentSecretRequestInput {
  conversationId: string;
  runId: string;
  turnId: string;
  providerId: ProviderId;
  title: string;
  description: string;
  fileName: string;
  ttlHours: number;
  createdAt?: string;
}

export interface AgentSecretRequestTransitionFields {
  answeredAt?: string;
  expiresAt?: string;
  fileToken?: string;
  vaulted?: boolean;
}

export interface AgentSecretRequestChange {
  request: AgentSecretRequestRecord;
  message: ChatMessage;
}

export type AgentSecretRequestErrorCode =
  | "turn-inactive"
  | "conversation-pending-limit"
  | "turn-limit"
  | "active-limit";

const ERROR_MESSAGES: Readonly<Record<AgentSecretRequestErrorCode, string>> = {
  "turn-inactive": "The turn that asked for this secret is no longer active.",
  "conversation-pending-limit": "This chat is already waiting for a secret.",
  "turn-limit": `This turn already asked for ${SECRET_REQUEST_MAX_PER_TURN} secrets.`,
  "active-limit": `Inertia already holds ${SECRET_REQUEST_MAX_ACTIVE} active agent secrets.`,
};

export class AgentSecretRequestError extends Error {
  constructor(readonly code: AgentSecretRequestErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AgentSecretRequestError";
  }
}

interface AgentSecretRequestStore {
  assertAgentTurnIdentity(conversationId: string, runId: string, turnId: string): AgentTurn;
  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"],
    attachments: [],
    turnId: string,
    createdAt: string,
    options: CreateMessageOptions,
  ): ChatMessage;
  message(messageId: string): ChatMessage;
}

interface AgentSecretRequestRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  run_id: string;
  message_id: string;
  provider_id: string;
  title: string;
  description: string;
  file_name: string;
  file_token: string | null;
  ttl_hours: number;
  status: SecretRequestStatus;
  vaulted: 0 | 1;
  created_at: string;
  answered_at: string | null;
  expires_at: string | null;
}

const NEXT_STATUSES: Readonly<Record<SecretRequestStatus, readonly SecretRequestStatus[]>> = {
  pending: ["saved", "declined", "ended"],
  saved: ["expired", "revoked"],
  declined: [],
  ended: [],
  expired: [],
  revoked: [],
};

const FILE_TOKEN = /^[0-9a-f]{32}$/u;
const SELECT_COLUMNS = `id, conversation_id, turn_id, run_id, message_id, provider_id, title, description,
  file_name, file_token, ttl_hours, status, vaulted, created_at, answered_at, expires_at`;

function recordFromRow(row: AgentSecretRequestRow): AgentSecretRequestRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    runId: row.run_id,
    messageId: row.message_id,
    providerId: row.provider_id as ProviderId,
    title: row.title,
    description: row.description,
    fileName: row.file_name,
    fileToken: row.file_token,
    ttlHours: row.ttl_hours,
    status: row.status,
    vaulted: row.vaulted === 1,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    expiresAt: row.expires_at,
  };
}

export function secretRequestReferenceFromRecord(record: AgentSecretRequestRecord): SecretRequestReference {
  const holdsValue = record.status === "saved" || record.status === "expired" || record.status === "revoked";
  return {
    requestId: record.id,
    title: record.title,
    description: record.description,
    ttlHours: record.ttlHours,
    status: record.status,
    answeredAt: record.answeredAt,
    expiresAt: holdsValue ? record.expiresAt : null,
    storage: holdsValue ? (record.vaulted ? "keychain" : "memory") : null,
  };
}

function transitionValues(
  to: SecretRequestStatus,
  fields: AgentSecretRequestTransitionFields,
  now: string,
): { answeredAt: string | null; expiresAt: string | null; fileToken: string | null; vaulted: number | null } {
  if (to === "saved") {
    if (fields.fileToken === undefined || !FILE_TOKEN.test(fields.fileToken)) throw new Error("Invalid secret file token.");
    if (fields.expiresAt === undefined || typeof fields.vaulted !== "boolean") throw new Error("Invalid saved secret fields.");
    return {
      answeredAt: fields.answeredAt === undefined ? now : requireTimestamp(fields.answeredAt, "Secret answer time"),
      expiresAt: requireTimestamp(fields.expiresAt, "Secret expiry time"),
      fileToken: fields.fileToken,
      vaulted: Number(fields.vaulted),
    };
  }
  if (fields.expiresAt !== undefined || fields.fileToken !== undefined || fields.vaulted !== undefined) {
    throw new Error("Only a saved secret records its file and expiry.");
  }
  if (to === "declined" || to === "ended") {
    return {
      answeredAt: fields.answeredAt === undefined ? now : requireTimestamp(fields.answeredAt, "Secret answer time"),
      expiresAt: null,
      fileToken: null,
      vaulted: null,
    };
  }
  if (fields.answeredAt !== undefined) throw new Error("An expired or revoked secret keeps its answer time.");
  return { answeredAt: null, expiresAt: null, fileToken: null, vaulted: null };
}

export class AgentSecretRequestRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly store: AgentSecretRequestStore,
  ) {}

  create(input: CreateAgentSecretRequestInput): AgentSecretRequestChange {
    if (!isSecretRequestTitle(input.title)) throw new Error("Invalid secret request title.");
    if (!isSecretRequestDescription(input.description)) throw new Error("Invalid secret request description.");
    if (!isSecretRequestFileName(input.fileName)) throw new Error("Invalid secret file name.");
    if (!isSecretRequestTtlHours(input.ttlHours)) throw new Error("Invalid secret lifetime.");
    if (!isSecretRequestProviderId(input.providerId)) throw new Error("Invalid secret request provider.");
    const createdAt = input.createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(input.createdAt, "Secret request creation time");
    return this.database.transaction((): AgentSecretRequestChange => {
      const turn = this.store.assertAgentTurnIdentity(input.conversationId, input.runId, input.turnId);
      if (isAgentTurnTerminalStatus(turn.status)) throw new AgentSecretRequestError("turn-inactive");
      const { pending, inTurn } = this.database.prepare(`SELECT
          COALESCE(SUM(conversation_id = ? AND status = 'pending'), 0) AS pending,
          COALESCE(SUM(turn_id = ?), 0) AS inTurn
        FROM agent_secret_requests WHERE conversation_id = ? OR turn_id = ?`)
        .get(input.conversationId, input.turnId, input.conversationId, input.turnId) as { pending: number; inTurn: number };
      if (pending >= SECRET_REQUEST_MAX_PENDING_PER_CONVERSATION) throw new AgentSecretRequestError("conversation-pending-limit");
      if (inTurn >= SECRET_REQUEST_MAX_PER_TURN) throw new AgentSecretRequestError("turn-limit");
      const id = randomUUID();
      const reference: SecretRequestReference = {
        requestId: id,
        title: input.title,
        description: input.description,
        ttlHours: input.ttlHours,
        status: "pending",
        answeredAt: null,
        expiresAt: null,
        storage: null,
      };
      const message = this.store.createMessage(
        input.conversationId,
        secretRequestPlaceholderText(input.title),
        "system",
        [],
        input.turnId,
        createdAt,
        { secretRequest: reference, activateConversation: false },
      );
      this.database.prepare(`INSERT INTO agent_secret_requests (
          id, conversation_id, turn_id, run_id, message_id, provider_id, title, description,
          file_name, ttl_hours, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
        id, input.conversationId, input.turnId, input.runId, message.id, input.providerId,
        input.title, input.description, input.fileName, input.ttlHours, createdAt,
      );
      return { request: this.require(id), message };
    })();
  }

  transition(
    id: string,
    from: readonly SecretRequestStatus[],
    to: SecretRequestStatus,
    fields: AgentSecretRequestTransitionFields = {},
  ): AgentSecretRequestChange | null {
    if (from.length === 0 || from.some((status) => !NEXT_STATUSES[status].includes(to))) {
      throw new Error("Invalid secret request transition.");
    }
    const values = transitionValues(to, fields, new Date().toISOString());
    return this.database.transaction((): AgentSecretRequestChange | null => {
      if (to === "saved") {
        const { active } = this.database.prepare(
          "SELECT COUNT(*) AS active FROM agent_secret_requests WHERE status = 'saved' AND id <> ?",
        ).get(id) as { active: number };
        if (active >= SECRET_REQUEST_MAX_ACTIVE) throw new AgentSecretRequestError("active-limit");
      }
      const changed = this.database.prepare(`UPDATE agent_secret_requests SET
          status = @to,
          answered_at = COALESCE(@answeredAt, answered_at),
          expires_at = COALESCE(@expiresAt, expires_at),
          file_token = COALESCE(@fileToken, file_token),
          vaulted = COALESCE(@vaulted, vaulted)
        WHERE id = @id AND status IN (SELECT value FROM json_each(@from))`).run({
        id,
        to,
        from: JSON.stringify(from),
        ...values,
      }).changes;
      if (changed === 0) return null;
      const request = this.require(id);
      const rewritten = this.database.prepare(
        "UPDATE messages SET secret_request_json = ? WHERE id = ? AND role = 'system'",
      ).run(JSON.stringify(secretRequestReferenceFromRecord(request)), request.messageId).changes;
      if (rewritten !== 1) throw new Error("The secret request message is missing.");
      return { request, message: this.store.message(request.messageId) };
    })();
  }

  find(id: string): AgentSecretRequestRecord | null {
    const row = this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_secret_requests WHERE id = ?`)
      .get(id) as AgentSecretRequestRow | undefined;
    return row ? recordFromRow(row) : null;
  }

  activeSaved(): AgentSecretRequestRecord[] {
    return this.list("status = 'saved'", "expires_at ASC, id ASC");
  }

  pendingAll(): AgentSecretRequestRecord[] {
    return this.list("status = 'pending'", "created_at ASC, id ASC");
  }

  forConversation(conversationId: string): AgentSecretRequestRecord[] {
    return this.list("conversation_id = ?", "created_at ASC, id ASC", conversationId);
  }

  private list(where: string, order: string, ...parameters: string[]): AgentSecretRequestRecord[] {
    return (this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_secret_requests WHERE ${where} ORDER BY ${order}`)
      .all(...parameters) as AgentSecretRequestRow[]).map(recordFromRow);
  }

  private require(id: string): AgentSecretRequestRecord {
    const record = this.find(id);
    if (!record) throw new Error("The secret request is missing.");
    return record;
  }
}
