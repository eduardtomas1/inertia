import { createHash, randomUUID } from "node:crypto";

import {
  canTransitionAgentTurnStatus,
  isAgentTurnTerminalStatus,
  type AgentTurn,
  type ChatMessage,
} from "../../shared/contracts";
import {
  continuationIdentityForSelection,
  continuationIdentitySchema,
  legacyProviderIdForHarness,
  modelSelectionSchema,
} from "../../shared/model-routing";
import {
  parseSanitizedTurnExecutionManifest,
  validateExecutionContextReference,
  validatePersistedTurnExecutionContext,
  type PersistedTurnExecutionContext,
  type SanitizedTurnExecutionManifest,
} from "../runtime/turns/request-context";
import {
  agentTurnFromRow,
  legacyModelSelection,
  normalizeAgentTurnUsage,
  optionalTurnString,
  requiredTurnString,
  requireTimestamp,
} from "./codecs";
import type { PersistenceContext } from "./context";
import type {
  AgentTurnRow,
  MessageRow,
} from "./rows";
import type {
  AgentTurnLifecycleUpdate,
  AgentTurnSettlementResult,
  AgentTurnSettlementUpdate,
  BeginAgentTurnInput,
  CreateAgentTurnInput,
} from "./types";

type TurnLedgerPersistenceContext = Pick<
  PersistenceContext,
  "createMessage" | "database" | "requireAgentTurn" | "requireConversation"
>;

export class TurnLedgerRepository {
  constructor(private readonly context: TurnLedgerPersistenceContext) {}

  create(input: CreateAgentTurnInput): AgentTurn {
    this.context.requireConversation(input.conversationId);
    if (!Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 0) {
      throw new Error("Turn configuration revision must be a non-negative integer.");
    }
    if (input.association !== "authoritative" && input.association !== "inferred") {
      throw new Error("Turn association must be authoritative or inferred.");
    }

    const modelSelection = input.modelSelection
      ? modelSelectionSchema.parse(input.modelSelection)
      : legacyModelSelection({
        providerId: input.providerId,
        harnessId: requiredTurnString(input.harnessId ?? "", "Turn harness ID", 200),
        backendProfileId: requiredTurnString(
          input.backendProfileId ?? "",
          "Turn backend profile ID",
          200,
        ),
        model: requiredTurnString(input.model ?? "", "Turn model", 300),
        modelAlias: input.modelAlias ?? null,
        reasoningEffort: input.reasoningEffort,
        configurationRevision: input.configurationRevision,
      });
    const selectedProviderId = legacyProviderIdForHarness(modelSelection.harnessId);
    if (selectedProviderId && selectedProviderId !== input.providerId) {
      throw new Error("The turn provider and harness identities do not match.");
    }
    if (
      input.modelSelection
      && input.configurationRevision !== modelSelection.backendConfigurationRevision
    ) {
      throw new Error("The turn configuration revision does not match its model selection.");
    }
    const continuationIdentity = input.continuationIdentity
      ? continuationIdentitySchema.parse(input.continuationIdentity)
      : continuationIdentityForSelection(modelSelection);
    if (
      continuationIdentity.harnessId !== modelSelection.harnessId
      || continuationIdentity.backendProfileId !== modelSelection.backendProfileId
      || continuationIdentity.backendConfigurationRevision
        !== modelSelection.backendConfigurationRevision
    ) {
      throw new Error("The turn continuation identity does not match its model selection.");
    }
    const modelSelectionJson = JSON.stringify(modelSelection);
    const continuationIdentityJson = JSON.stringify(continuationIdentity);
    if (new TextEncoder().encode(modelSelectionJson).byteLength > 65_536) {
      throw new Error("Turn model selection is too large.");
    }
    if (new TextEncoder().encode(continuationIdentityJson).byteLength > 4_096) {
      throw new Error("Turn continuation identity is too large.");
    }

    const requestedAt = requireTimestamp(input.requestedAt ?? new Date().toISOString(), "Turn request time");
    const usageAtStart = input.usageAtStart ? normalizeAgentTurnUsage(input.usageAtStart) : null;
    const usageStartJson = usageAtStart ? JSON.stringify(usageAtStart) : null;
    if (usageStartJson && usageStartJson.length > 16_384) throw new Error("Turn usage snapshot is too large.");
    const reasoningEffort = (modelSelection.reasoningEffort ?? "").trim();
    if (reasoningEffort.length > 80) throw new Error("Turn reasoning effort cannot exceed 80 characters.");

    const turn: AgentTurn = {
      id: requiredTurnString(input.id ?? randomUUID(), "Turn ID", 200),
      conversationId: input.conversationId,
      runId: requiredTurnString(input.runId, "Turn run ID", 200),
      userMessageId: requiredTurnString(input.userMessageId, "Turn user message ID", 200),
      terminalAssistantMessageId: null,
      providerId: input.providerId,
      modelSelection,
      continuationIdentity,
      harnessId: modelSelection.harnessId,
      backendProfileId: modelSelection.backendProfileId,
      model: modelSelection.modelId,
      modelAlias: modelSelection.alias,
      reasoningEffort,
      interactionMode: input.interactionMode,
      accessMode: input.accessMode,
      providerSessionBefore: optionalTurnString(input.providerSessionBefore, "Turn provider session", 1_000),
      providerSessionAfter: null,
      requestedAt,
      startedAt: null,
      completedAt: null,
      status: "queued",
      terminalReason: null,
      checkpointId: null,
      usageAtStart,
      usageAtCompletion: null,
      configurationRevision: modelSelection.backendConfigurationRevision,
      association: input.association,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    };

    const userMessage = this.context.database.prepare("SELECT * FROM messages WHERE id = ?").get(turn.userMessageId) as MessageRow | undefined;
    if (!userMessage || userMessage.conversation_id !== turn.conversationId || userMessage.role !== "user") {
      throw new Error("An agent turn must reference a user message in the same conversation.");
    }
    if (userMessage.turn_id !== null && userMessage.turn_id !== turn.id) {
      throw new Error("The user message is already owned by a different turn.");
    }

    const insertTurn = this.context.database.prepare(`
      INSERT INTO agent_turns (
        id, conversation_id, run_id, user_message_id, terminal_assistant_message_id,
        provider_id, model_selection_json, continuation_identity_json,
        harness_id, backend_profile_id, model, model_alias, reasoning_effort,
        interaction_mode, access_mode, provider_session_before, provider_session_after,
        requested_at, started_at, completed_at, status, terminal_reason, checkpoint_id,
        usage_start_json, usage_completion_json, configuration_revision, association,
        created_at, updated_at
      ) VALUES (
        @id, @conversationId, @runId, @userMessageId, @terminalAssistantMessageId,
        @providerId, @modelSelectionJson, @continuationIdentityJson,
        @harnessId, @backendProfileId, @model, @modelAlias, @reasoningEffort,
        @interactionMode, @accessMode, @providerSessionBefore, @providerSessionAfter,
        @requestedAt, @startedAt, @completedAt, @status, @terminalReason, @checkpointId,
        @usageStartJson, NULL, @configurationRevision, @association, @createdAt, @updatedAt
      )
    `);
    this.context.database.transaction(() => {
      insertTurn.run({
        ...turn,
        usageStartJson,
        modelSelectionJson,
        continuationIdentityJson,
      });
      this.context.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turn.id, turn.userMessageId);
    })();
    return turn;
  }

  /**
   * Persists the visible user request and its queued authoritative turn in one
   * transaction. A failed turn insert rolls the message and conversation touch
   * back, so a submitted request cannot survive as an unowned user message.
   */
  begin(input: BeginAgentTurnInput): { message: ChatMessage; turn: AgentTurn } {
    return this.context.database.transaction(() => {
      const message = this.context.createMessage(
        input.conversationId,
        input.content,
        "user",
        input.attachments ?? [],
        null,
        input.requestedAt,
        { activateConversation: input.activateConversation },
      );
      const turn = this.create({
        ...input,
        userMessageId: message.id,
        requestedAt: message.createdAt,
      });
      if (input.executionContext) {
        this.persistExecutionContext(turn.id, input.executionContext, message.createdAt);
      }
      return { message, turn };
    })();
  }

  /**
   * Privileged server-side debugging view. Ordinary renderer snapshots and
   * WebSocket events intentionally never include this manifest or its blobs.
   */
  executionManifest(turnId: string): SanitizedTurnExecutionManifest | null {
    this.context.requireAgentTurn(turnId);
    const row = this.context.database.prepare(`
      SELECT manifest_json
      FROM turn_execution_manifests
      WHERE turn_id = ?
    `).get(turnId) as { manifest_json: string } | undefined;
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.manifest_json);
    } catch {
      throw new Error("Turn execution manifest contains invalid JSON.");
    }
    const manifest = parseSanitizedTurnExecutionManifest(parsed);
    const references = this.context.database.prepare(`
      SELECT ordinal, digest, kind, label, byte_size, truncated
      FROM turn_execution_context_refs
      WHERE turn_id = ?
      ORDER BY ordinal ASC
    `).all(turnId) as Array<{
      ordinal: number;
      digest: string;
      kind: string;
      label: string;
      byte_size: number;
      truncated: 0 | 1;
    }>;
    if (references.length !== manifest.references.length) {
      throw new Error("Turn execution manifest reference rows are incomplete.");
    }
    for (const [ordinal, reference] of manifest.references.entries()) {
      const rowReference = references[ordinal];
      const digest = validateExecutionContextReference(reference.reference);
      if (
        !rowReference
        || rowReference.ordinal !== ordinal
        || rowReference.digest !== digest
        || rowReference.kind !== reference.kind
        || rowReference.label !== reference.label
        || rowReference.byte_size !== reference.byteSize
        || Boolean(rowReference.truncated) !== reference.truncated
      ) {
        throw new Error("Turn execution manifest reference metadata is malformed.");
      }
      const blob = this.context.database.prepare(`
        SELECT byte_size, content
        FROM turn_execution_context_blobs
        WHERE digest = ?
      `).get(digest) as { byte_size: number; content: string } | undefined;
      if (
        !blob
        || blob.byte_size !== reference.byteSize
        || Buffer.byteLength(blob.content, "utf8") !== reference.byteSize
        || createHash("sha256").update(blob.content, "utf8").digest("hex") !== digest
      ) {
        throw new Error("Turn execution manifest refers to missing or malformed content.");
      }
    }
    return manifest;
  }

  get(turnId: string): AgentTurn {
    return agentTurnFromRow(this.context.requireAgentTurn(turnId));
  }

  forRun(runId: string): AgentTurn | null {
    const row = this.context.database.prepare("SELECT * FROM agent_turns WHERE run_id = ?").get(runId) as AgentTurnRow | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  latestForConversation(conversationId: string): AgentTurn | null {
    this.context.requireConversation(conversationId);
    const row = this.context.database.prepare(`
      SELECT * FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as AgentTurnRow | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  assertIdentity(conversationId: string, runId: string, turnId: string): AgentTurn {
    const turn = agentTurnFromRow(this.context.requireAgentTurn(turnId));
    if (turn.conversationId !== conversationId || turn.runId !== runId) {
      throw new Error("The event conversation, run, and turn identities do not match.");
    }
    return turn;
  }

  forConversation(conversationId: string): AgentTurn[] {
    this.context.requireConversation(conversationId);
    return (this.context.database.prepare(`
      SELECT * FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at ASC, id ASC
    `).all(conversationId) as AgentTurnRow[]).map(agentTurnFromRow);
  }

  unfinished(): AgentTurn[] {
    return (this.context.database.prepare(`
      SELECT * FROM agent_turns
      WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY requested_at ASC, id ASC
    `).all() as AgentTurnRow[]).map(agentTurnFromRow);
  }

  terminalAuthoritativeMissingGitArtifacts(): AgentTurn[] {
    return (this.context.database.prepare(`
      SELECT turn.*
      FROM agent_turns AS turn
      LEFT JOIN turn_git_artifacts AS artifact ON artifact.turn_id = turn.id
      WHERE turn.association = 'authoritative'
        AND turn.status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND artifact.turn_id IS NULL
      ORDER BY turn.requested_at ASC, turn.id ASC
    `).all() as AgentTurnRow[]).map(agentTurnFromRow);
  }

  updateLifecycle(turnId: string, update: AgentTurnLifecycleUpdate): AgentTurn {
    const current = agentTurnFromRow(this.context.requireAgentTurn(turnId));
    if (!canTransitionAgentTurnStatus(current.status, update.status)) {
      throw new Error(`Agent turn cannot transition from ${current.status} to ${update.status}.`);
    }

    const updatedAt = requireTimestamp(update.updatedAt ?? new Date().toISOString(), "Turn update time");
    if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error("Turn update time cannot move backwards.");
    }
    const terminal = isAgentTurnTerminalStatus(update.status);
    const startsWork = update.status !== "queued";
    if (!startsWork && update.startedAt !== undefined) {
      throw new Error("A queued turn cannot have a start time.");
    }

    const requestedStartedAt = update.startedAt === undefined
      ? null
      : requireTimestamp(update.startedAt, "Turn start time");
    if (current.startedAt && requestedStartedAt && requestedStartedAt !== current.startedAt) {
      throw new Error("Turn start time is write-once.");
    }
    const startedAt = current.startedAt ?? (startsWork ? (requestedStartedAt ?? updatedAt) : null);
    if (startedAt && Date.parse(startedAt) < Date.parse(current.requestedAt)) {
      throw new Error("Turn start time cannot precede its request time.");
    }
    if (startedAt && Date.parse(startedAt) > Date.parse(updatedAt)) {
      throw new Error("Turn start time cannot follow its update time.");
    }

    if (!terminal) {
      const hasTerminalMetadata = update.completedAt !== undefined
        || update.terminalAssistantMessageId !== undefined
        || update.providerSessionAfter !== undefined
        || update.terminalReason !== undefined
        || update.checkpointId !== undefined
        || update.usageAtCompletion !== undefined;
      if (hasTerminalMetadata) throw new Error("Terminal turn metadata requires a terminal status.");
    }

    const requestedCompletedAt = update.completedAt === undefined
      ? null
      : requireTimestamp(update.completedAt, "Turn completion time");
    if (current.completedAt && requestedCompletedAt && requestedCompletedAt !== current.completedAt) {
      throw new Error("Turn completion time is write-once.");
    }
    const completedAt = terminal
      ? (current.completedAt ?? requestedCompletedAt ?? updatedAt)
      : null;
    if (completedAt && (!startedAt || Date.parse(completedAt) < Date.parse(startedAt))) {
      throw new Error("Turn completion time cannot precede its start time.");
    }
    if (completedAt && Date.parse(completedAt) > Date.parse(updatedAt)) {
      throw new Error("Turn completion time cannot follow its update time.");
    }

    const writeOnceString = (
      currentValue: string | null,
      requestedValue: string | null | undefined,
      label: string,
      maximum: number,
    ): string | null => {
      if (requestedValue === undefined) return currentValue;
      const normalized = optionalTurnString(requestedValue, label, maximum);
      if (currentValue !== null && normalized !== currentValue) throw new Error(`${label} is write-once.`);
      return normalized;
    };
    const terminalAssistantMessageId = terminal
      ? writeOnceString(current.terminalAssistantMessageId, update.terminalAssistantMessageId, "Terminal assistant message ID", 200)
      : null;
    const providerSessionAfter = terminal
      ? writeOnceString(current.providerSessionAfter, update.providerSessionAfter, "Terminal provider session", 1_000)
      : null;
    const terminalReason = terminal
      ? writeOnceString(current.terminalReason, update.terminalReason, "Turn terminal reason", 4_000)
      : null;
    const checkpointId = terminal
      ? writeOnceString(current.checkpointId, update.checkpointId, "Turn checkpoint ID", 200)
      : null;

    let usageAtCompletion = current.usageAtCompletion;
    if (terminal && update.usageAtCompletion !== undefined) {
      const requestedUsage = update.usageAtCompletion ? normalizeAgentTurnUsage(update.usageAtCompletion) : null;
      if (
        current.usageAtCompletion !== null
        && JSON.stringify(requestedUsage) !== JSON.stringify(current.usageAtCompletion)
      ) {
        throw new Error("Turn completion usage is write-once.");
      }
      usageAtCompletion = requestedUsage;
    }
    const usageCompletionJson = usageAtCompletion ? JSON.stringify(usageAtCompletion) : null;
    if (usageCompletionJson && usageCompletionJson.length > 16_384) throw new Error("Turn usage snapshot is too large.");

    const next: AgentTurn = {
      ...current,
      terminalAssistantMessageId,
      providerSessionAfter,
      startedAt,
      completedAt,
      status: update.status,
      terminalReason,
      checkpointId,
      usageAtCompletion,
      updatedAt,
    };
    let terminalMessage: MessageRow | undefined;
    if (terminalAssistantMessageId) {
      terminalMessage = this.context.database.prepare("SELECT * FROM messages WHERE id = ?").get(terminalAssistantMessageId) as MessageRow | undefined;
      if (
        !terminalMessage
        || terminalMessage.conversation_id !== current.conversationId
        || terminalMessage.role !== "assistant"
      ) {
        throw new Error("The terminal assistant message must belong to the same conversation.");
      }
      if (terminalMessage.turn_id !== null && terminalMessage.turn_id !== current.id) {
        throw new Error("The terminal assistant message is already owned by a different turn.");
      }
    }
    const updateTurn = this.context.database.prepare(`
      UPDATE agent_turns SET
        terminal_assistant_message_id = @terminalAssistantMessageId,
        provider_session_after = @providerSessionAfter,
        started_at = @startedAt,
        completed_at = @completedAt,
        status = @status,
        terminal_reason = @terminalReason,
        checkpoint_id = @checkpointId,
        usage_completion_json = @usageCompletionJson,
        updated_at = @updatedAt
      WHERE id = @id
        AND status = @previousStatus
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    `);
    this.context.database.transaction(() => {
      const result = updateTurn.run({ ...next, usageCompletionJson, previousStatus: current.status });
      if (result.changes !== 1) {
        throw new Error("Agent turn lifecycle changed concurrently or was already settled.");
      }
      if (terminalMessage) {
        this.context.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(current.id, terminalMessage.id);
      }
    })();
    return next;
  }

  /**
   * Atomically wins one terminal outcome. Callers losing a completion/cancel/
   * process-exit race receive the already-authoritative turn without changing
   * its status, timestamps, reason, session, message, checkpoint, or usage.
   */
  settle(turnId: string, update: AgentTurnSettlementUpdate): AgentTurnSettlementResult {
    const current = this.get(turnId);
    if (isAgentTurnTerminalStatus(current.status)) return { settled: false, turn: current };
    try {
      return {
        settled: true,
        turn: this.updateLifecycle(turnId, update),
      };
    } catch (error) {
      const latest = this.get(turnId);
      if (isAgentTurnTerminalStatus(latest.status)) return { settled: false, turn: latest };
      throw error;
    }
  }

  private persistExecutionContext(
    turnId: string,
    input: PersistedTurnExecutionContext,
    createdAt: string,
  ): void {
    this.context.requireAgentTurn(turnId);
    const context = validatePersistedTurnExecutionContext(input);
    const manifestJson = JSON.stringify(context.manifest);
    if (Buffer.byteLength(manifestJson, "utf8") > 65_536) {
      throw new Error("Turn execution manifest exceeds its persistence limit.");
    }
    const insertBlob = this.context.database.prepare(`
      INSERT INTO turn_execution_context_blobs (digest, byte_size, content, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(digest) DO NOTHING
    `);
    const selectBlob = this.context.database.prepare(`
      SELECT byte_size, content
      FROM turn_execution_context_blobs
      WHERE digest = ?
    `);
    for (const blob of context.blobs) {
      insertBlob.run(blob.digest, blob.byteSize, blob.content, createdAt);
      const stored = selectBlob.get(blob.digest) as { byte_size: number; content: string } | undefined;
      if (
        !stored
        || stored.byte_size !== blob.byteSize
        || stored.content !== blob.content
      ) {
        throw new Error("Content-addressed execution context collided with different content.");
      }
    }
    this.context.database.prepare(`
      INSERT INTO turn_execution_manifests (turn_id, manifest_json, created_at)
      VALUES (?, ?, ?)
    `).run(turnId, manifestJson, createdAt);
    const insertReference = this.context.database.prepare(`
      INSERT INTO turn_execution_context_refs (
        turn_id, ordinal, digest, kind, label, byte_size, truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [ordinal, reference] of context.manifest.references.entries()) {
      insertReference.run(
        turnId,
        ordinal,
        validateExecutionContextReference(reference.reference),
        reference.kind,
        reference.label,
        reference.byteSize,
        Number(reference.truncated),
      );
    }
  }
}
