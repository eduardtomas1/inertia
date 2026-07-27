import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  type AgentActivity,
  type AgentPlan,
  type AgentReasoning,
  type AgentTurn,
  type AppSettings,
  type AppSnapshot,
  type ChatAttachment,
  type ChatMessage,
  type CheckpointSummary,
  type Conversation,
  type ConversationDetail,
  type DiffReviewNote,
  type DiffReviewState,
  type DiffReviewSummary,
  type ModelSelection,
  type Project,
  type ProviderId,
  type ProviderInfo,
  type SubagentTrace,
  type SubagentTraceStatus,
  type ThreadUsageSnapshot,
  type TurnGitArtifact,
  type WorkspaceRun,
  canTransitionAgentTurnStatus,
  isAgentTurnTerminalStatus,
} from "../shared/contracts";
import {
  continuationIdentityForSelection,
  continuationIdentitySchema,
  legacyProviderIdForHarness,
  modelSelectionSchema,
  nativeModelSelection,
} from "../shared/model-routing";
import {
  type ModelBackendDefault,
  type PersistedModelBackendProfile,
} from "../shared/backend-profile-settings";
import {
  type BackendCompatibilityProbeResult,
} from "../shared/backend-probe";
import {
  backfillLegacyAgentTurns,
  formatMigrationDiagnostic,
  runDatabaseMigrations,
} from "./database-migrations";
import {
  nativeProviderMetadataScope,
  providerMetadataScopeKey,
  type PersistedProviderMetadata,
} from "./provider/metadata";
import { validateProviderUsage } from "./provider/usage-values";
import {
  boundedSubagentIdentifier,
  boundedSubagentText,
  isTerminalSubagentStatus,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_PROGRESS_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_TRACES_PER_TURN,
} from "./provider/subagent-trace";
import {
  parseSanitizedTurnExecutionManifest,
  validateExecutionContextReference,
  validatePersistedTurnExecutionContext,
  type PersistedTurnExecutionContext,
  type SanitizedTurnExecutionManifest,
} from "./runtime/turns/request-context";
import {
  activityFromRow,
  agentTurnFromRow,
  checkpointFromRow,
  legacyModelSelection,
  normalizeAgentTurnUsage,
  optionalTurnString,
  reasoningFromRow,
  requiredTurnString,
  requireTimestamp,
  subagentTraceFromRow,
  usageFromRow,
} from "./persistence/codecs";
import { BackendProfileRepository } from "./persistence/backend-profile-repository";
import { ConversationRepository } from "./persistence/conversation-repository";
import { RecordNotFoundError } from "./persistence/errors";
import {
  normalizeTurnGitArtifactFiles,
  optionalArtifactRef,
  optionalSha256,
  storedTurnGitArtifactFromRow,
  turnGitArtifactFromRow,
} from "./persistence/git-artifact-codecs";
import {
  createRuntimeMigrationCatalog,
  type DatabaseMigrationDefinition,
} from "./persistence/migrations/catalog";
import { LEGACY_SCHEMA_SQL } from "./persistence/migrations/legacy-schema";
import { ProviderMetadataRepository } from "./persistence/provider-metadata-repository";
import { ProjectRepository } from "./persistence/project-repository";
import { ReviewRepository } from "./persistence/review-repository";
import { SettingsRepository } from "./persistence/settings-repository";
import { SnapshotRepository } from "./persistence/snapshot-repository";
import { TranscriptRepository } from "./persistence/transcript-repository";
import { WorkspaceRunRepository } from "./persistence/workspace-run-repository";
import type {
  ActivityRow,
  AgentReasoningRow,
  AgentTurnRow,
  CheckpointRow,
  ConversationRow,
  MessageRow,
  ProjectRow,
  SubagentTraceRow,
  ThreadUsageRow,
  TurnGitArtifactRow,
} from "./persistence/rows";
import type {
  AgentTurnLifecycleUpdate,
  AgentTurnSettlementResult,
  AgentTurnSettlementUpdate,
  BeginAgentTurnInput,
  CompleteTurnGitArtifactInput,
  CreateAgentTurnInput,
  CreateTurnGitArtifactInput,
  NewConversationOptions,
  RuntimeStoreSnapshot,
  StoredModelBackendProfile,
  StoredTurnGitArtifact,
  UpsertSubagentTraceInput,
  UpsertSubagentTraceResult,
} from "./persistence/types";

export { RecordNotFoundError } from "./persistence/errors";
export type {
  AgentTurnLifecycleUpdate,
  AgentTurnSettlementResult,
  AgentTurnSettlementUpdate,
  BeginAgentTurnInput,
  CompleteTurnGitArtifactInput,
  CreateAgentTurnInput,
  CreateTurnGitArtifactInput,
  NewConversationOptions,
  RuntimeStoreSnapshot,
  StoredModelBackendProfile,
  StoredTurnGitArtifact,
  UpsertSubagentTraceInput,
  UpsertSubagentTraceResult,
} from "./persistence/types";

export class RuntimeStore {
  private readonly database: Database.Database;
  private readonly backendProfileRepository: BackendProfileRepository;
  private readonly conversationRepository: ConversationRepository;
  private readonly providerMetadataRepository: ProviderMetadataRepository;
  private readonly projectRepository: ProjectRepository;
  private readonly reviewRepository: ReviewRepository;
  private readonly settingsRepository: SettingsRepository;
  private readonly snapshotRepository: SnapshotRepository;
  private readonly transcriptRepository: TranscriptRepository;
  private readonly workspaceRunRepository: WorkspaceRunRepository;

  constructor(
    databasePath: string,
    _defaultWorkspacePath: string,
    options: { recoverInterruptedRuns?: boolean } = {},
  ) {
    this.database = new Database(databasePath);
    this.backendProfileRepository = new BackendProfileRepository({
      database: this.database,
      requireProject: (projectId) => this.requireProject(projectId),
    });
    this.providerMetadataRepository = new ProviderMetadataRepository(this.database);
    this.projectRepository = new ProjectRepository({
      database: this.database,
      requireProject: (projectId) => this.requireProject(projectId),
    });
    this.settingsRepository = new SettingsRepository({ database: this.database });
    this.conversationRepository = new ConversationRepository({
      database: this.database,
      requireConversation: (conversationId) => this.requireConversation(conversationId),
      requireProject: (projectId) => this.requireProject(projectId),
      selectProject: (projectId) => this.projectRepository.select(projectId),
      state: () => this.settingsRepository.state(),
      touchProject: (projectId, timestamp) => this.projectRepository.touch(projectId, timestamp),
    });
    this.reviewRepository = new ReviewRepository({
      database: this.database,
      requireConversation: (conversationId) => this.requireConversation(conversationId),
    });
    this.snapshotRepository = new SnapshotRepository({ database: this.database });
    this.transcriptRepository = new TranscriptRepository({
      assertAgentTurnIdentity: (conversationId, runId, turnId) =>
        this.assertAgentTurnIdentity(conversationId, runId, turnId),
      database: this.database,
      requireAgentTurn: (turnId) => this.requireAgentTurn(turnId),
      requireConversation: (conversationId) => this.requireConversation(conversationId),
      touchProject: (projectId, timestamp) => this.projectRepository.touch(projectId, timestamp),
    });
    this.workspaceRunRepository = new WorkspaceRunRepository({
      database: this.database,
      requireConversation: (conversationId) => this.requireConversation(conversationId),
      requireProject: (projectId) => this.requireProject(projectId),
    });
    try {
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      this.migrate();
      this.database.pragma("journal_mode = WAL");
      this.initializeState();
      if (options.recoverInterruptedRuns !== false) this.recoverInterruptedRuns();
    } catch (error) {
      if (this.database.open) this.database.close();
      throw error;
    }
  }

  close(): void {
    if (this.database.open) this.database.close();
  }

  snapshot(providers: ProviderInfo[] = []): RuntimeStoreSnapshot {
    return this.snapshotRepository.snapshot(providers);
  }

  shellSnapshot(providers: ProviderInfo[] = []): AppSnapshot {
    return this.snapshotRepository.shellSnapshot(providers);
  }

  conversationDetail(conversationId: string): ConversationDetail | null {
    return this.snapshotRepository.conversationDetail(conversationId);
  }

  loadProviderMetadata(): PersistedProviderMetadata[] {
    return this.providerMetadataRepository.load();
  }

  saveProviderMetadata(metadata: PersistedProviderMetadata): void {
    this.providerMetadataRepository.save(metadata);
  }

  createProject(
    name: string,
    projectPath: string,
    identity: Partial<Pick<Project, "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath">> = {},
  ): Project {
    return this.projectRepository.create(name, projectPath, identity);
  }

  updateProject(
    projectId: string,
    update: Partial<Pick<Project, "name" | "groupingMode" | "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath">>,
  ): Project {
    return this.projectRepository.update(projectId, update);
  }

  removeProject(projectId: string): void {
    this.projectRepository.remove(projectId);
  }

  selectProject(projectId: string): void {
    this.projectRepository.select(projectId);
  }

  createConversation(projectId: string, title: string, options: NewConversationOptions = {}): Conversation {
    return this.conversationRepository.create(projectId, title, options);
  }

  selectConversation(conversationId: string): void {
    this.conversationRepository.select(conversationId);
  }

  hasConversationMessages(conversationId: string): boolean {
    return this.conversationRepository.hasMessages(conversationId);
  }

  hasConversationTurns(conversationId: string): boolean {
    return this.conversationRepository.hasTurns(conversationId);
  }

  updateConversation(conversationId: string, update: Partial<Pick<Conversation, "title" | "providerId" | "modelSelection" | "continuationIdentity" | "model" | "reasoningEffort" | "interactionMode" | "accessMode" | "branch" | "worktreePath" | "providerSessionId" | "status" | "attentionKind">>): Conversation {
    return this.conversationRepository.update(conversationId, update);
  }

  createAgentTurn(input: CreateAgentTurnInput): AgentTurn {
    this.requireConversation(input.conversationId);
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

    const userMessage = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(turn.userMessageId) as MessageRow | undefined;
    if (!userMessage || userMessage.conversation_id !== turn.conversationId || userMessage.role !== "user") {
      throw new Error("An agent turn must reference a user message in the same conversation.");
    }
    if (userMessage.turn_id !== null && userMessage.turn_id !== turn.id) {
      throw new Error("The user message is already owned by a different turn.");
    }

    const insertTurn = this.database.prepare(`
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
    this.database.transaction(() => {
      insertTurn.run({
        ...turn,
        usageStartJson,
        modelSelectionJson,
        continuationIdentityJson,
      });
      this.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(turn.id, turn.userMessageId);
    })();
    return turn;
  }

  /**
   * Persists the visible user request and its queued authoritative turn in one
   * transaction. A failed turn insert rolls the message and conversation touch
   * back, so a submitted request cannot survive as an unowned user message.
   */
  beginAgentTurn(input: BeginAgentTurnInput): { message: ChatMessage; turn: AgentTurn } {
    return this.database.transaction(() => {
      const message = this.createMessage(
        input.conversationId,
        input.content,
        "user",
        input.attachments ?? [],
        null,
        input.requestedAt,
      );
      const turn = this.createAgentTurn({
        ...input,
        userMessageId: message.id,
        requestedAt: message.createdAt,
      });
      if (input.executionContext) {
        this.persistTurnExecutionContext(turn.id, input.executionContext, message.createdAt);
      }
      return { message, turn };
    })();
  }

  /**
   * Privileged server-side debugging view. Ordinary renderer snapshots and
   * WebSocket events intentionally never include this manifest or its blobs.
   */
  turnExecutionManifest(turnId: string): SanitizedTurnExecutionManifest | null {
    this.requireAgentTurn(turnId);
    const row = this.database.prepare(`
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
    const references = this.database.prepare(`
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
      const blob = this.database.prepare(`
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

  private persistTurnExecutionContext(
    turnId: string,
    input: PersistedTurnExecutionContext,
    createdAt: string,
  ): void {
    this.requireAgentTurn(turnId);
    const context = validatePersistedTurnExecutionContext(input);
    const manifestJson = JSON.stringify(context.manifest);
    if (Buffer.byteLength(manifestJson, "utf8") > 65_536) {
      throw new Error("Turn execution manifest exceeds its persistence limit.");
    }
    const insertBlob = this.database.prepare(`
      INSERT INTO turn_execution_context_blobs (digest, byte_size, content, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(digest) DO NOTHING
    `);
    const selectBlob = this.database.prepare(`
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
    this.database.prepare(`
      INSERT INTO turn_execution_manifests (turn_id, manifest_json, created_at)
      VALUES (?, ?, ?)
    `).run(turnId, manifestJson, createdAt);
    const insertReference = this.database.prepare(`
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

  agentTurn(turnId: string): AgentTurn {
    return agentTurnFromRow(this.requireAgentTurn(turnId));
  }

  agentTurnForRun(runId: string): AgentTurn | null {
    const row = this.database.prepare("SELECT * FROM agent_turns WHERE run_id = ?").get(runId) as AgentTurnRow | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  latestAgentTurnForConversation(conversationId: string): AgentTurn | null {
    this.requireConversation(conversationId);
    const row = this.database.prepare(`
      SELECT * FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `).get(conversationId) as AgentTurnRow | undefined;
    return row ? agentTurnFromRow(row) : null;
  }

  assertAgentTurnIdentity(conversationId: string, runId: string, turnId: string): AgentTurn {
    const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
    if (turn.conversationId !== conversationId || turn.runId !== runId) {
      throw new Error("The event conversation, run, and turn identities do not match.");
    }
    return turn;
  }

  agentTurnsForConversation(conversationId: string): AgentTurn[] {
    this.requireConversation(conversationId);
    return (this.database.prepare(`
      SELECT * FROM agent_turns
      WHERE conversation_id = ?
      ORDER BY requested_at ASC, id ASC
    `).all(conversationId) as AgentTurnRow[]).map(agentTurnFromRow);
  }

  unfinishedAgentTurns(): AgentTurn[] {
    return (this.database.prepare(`
      SELECT * FROM agent_turns
      WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY requested_at ASC, id ASC
    `).all() as AgentTurnRow[]).map(agentTurnFromRow);
  }

  terminalAuthoritativeAgentTurnsMissingGitArtifacts(): AgentTurn[] {
    return (this.database.prepare(`
      SELECT turn.*
      FROM agent_turns AS turn
      LEFT JOIN turn_git_artifacts AS artifact ON artifact.turn_id = turn.id
      WHERE turn.association = 'authoritative'
        AND turn.status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND artifact.turn_id IS NULL
      ORDER BY turn.requested_at ASC, turn.id ASC
    `).all() as AgentTurnRow[]).map(agentTurnFromRow);
  }

  createTurnGitArtifact(input: CreateTurnGitArtifactInput): StoredTurnGitArtifact {
    const turn = this.agentTurn(input.turnId);
    const createdAt = requireTimestamp(input.createdAt ?? new Date().toISOString(), "Artifact creation time");
    const beforeCheckpointId = optionalTurnString(
      input.beforeCheckpointId,
      "Artifact checkpoint ID",
      200,
    );
    if (beforeCheckpointId) {
      const checkpoint = this.checkpoint(beforeCheckpointId);
      if (checkpoint.conversationId !== turn.conversationId) {
        throw new Error("The artifact checkpoint belongs to a different conversation.");
      }
      if (checkpoint.turnId !== null && checkpoint.turnId !== turn.id) {
        throw new Error("The artifact checkpoint belongs to a different turn.");
      }
    }
    const status = input.status ?? "pending";
    if (!["pending", "ready", "partial", "unavailable", "failed"].includes(status)) {
      throw new Error("The turn Git artifact status is invalid.");
    }
    const artifact: StoredTurnGitArtifact = {
      id: requiredTurnString(input.id ?? randomUUID(), "Artifact ID", 200),
      turnId: turn.id,
      conversationId: turn.conversationId,
      runId: turn.runId,
      repositoryIdentity: optionalSha256(input.repositoryIdentity, "Repository identity"),
      worktreeIdentity: optionalSha256(input.worktreeIdentity, "Worktree identity"),
      branch: optionalTurnString(input.branch, "Artifact branch", 300),
      beforeCheckpointId,
      beforeRef: optionalArtifactRef(input.beforeRef, "Artifact before reference"),
      afterRef: null,
      beforeFingerprint: optionalSha256(input.beforeFingerprint, "Artifact before fingerprint"),
      afterFingerprint: null,
      files: [],
      insertions: 0,
      deletions: 0,
      status,
      completeness: input.completeness ?? (status === "unavailable" ? "unavailable" : "partial"),
      patchState: "none",
      patchDigest: null,
      capturedAt: null,
      terminalAssistantMessageId: null,
      failureReason: optionalTurnString(input.failureReason, "Artifact failure reason", 1_000),
      absenceReason: input.absenceReason === "not-repository"
        ? input.absenceReason
        : null,
      createdAt,
      updatedAt: createdAt,
    };
    this.database.prepare(`
      INSERT INTO turn_git_artifacts (
        id, turn_id, conversation_id, run_id, repository_identity, worktree_identity,
        branch, before_checkpoint_id, before_ref, after_ref, before_fingerprint,
        after_fingerprint, files_json, insertions, deletions, status, completeness,
        patch_state, patch_digest, captured_at, terminal_assistant_message_id,
        failure_reason, absence_reason, created_at, updated_at
      ) VALUES (
        @id, @turnId, @conversationId, @runId, @repositoryIdentity, @worktreeIdentity,
        @branch, @beforeCheckpointId, @beforeRef, NULL, @beforeFingerprint,
        NULL, '[]', 0, 0, @status, @completeness,
        'none', NULL, NULL, NULL, @failureReason, @absenceReason, @createdAt, @updatedAt
      )
    `).run(artifact);
    return artifact;
  }

  completeTurnGitArtifact(
    turnId: string,
    input: CompleteTurnGitArtifactInput,
  ): StoredTurnGitArtifact {
    const row = this.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    if (!row) throw new RecordNotFoundError("Turn Git artifact not found.");
    const current = storedTurnGitArtifactFromRow(row);
    const updatedAt = requireTimestamp(input.updatedAt ?? new Date().toISOString(), "Artifact update time");
    if (Date.parse(updatedAt) < Date.parse(current.updatedAt)) {
      throw new Error("Artifact update time cannot move backwards.");
    }
    const files = input.files === undefined
      ? current.files
      : normalizeTurnGitArtifactFiles(input.files);
    const filesJson = JSON.stringify(files);
    if (filesJson.length > 262_144) throw new Error("Turn Git artifact file metadata is too large.");
    const insertions = input.insertions ?? current.insertions;
    const deletions = input.deletions ?? current.deletions;
    if (
      !Number.isSafeInteger(insertions)
      || insertions < 0
      || !Number.isSafeInteger(deletions)
      || deletions < 0
    ) throw new Error("Artifact statistics must be non-negative integers.");
    const afterRef = input.afterRef === undefined
      ? current.afterRef
      : optionalArtifactRef(input.afterRef, "Artifact after reference");
    const afterFingerprint = input.afterFingerprint === undefined
      ? current.afterFingerprint
      : optionalSha256(input.afterFingerprint, "Artifact after fingerprint");
    const patchDigest = input.patchDigest === undefined
      ? current.patchDigest
      : optionalSha256(input.patchDigest, "Artifact patch digest");
    const capturedAt = input.capturedAt === undefined
      ? current.capturedAt
      : input.capturedAt === null
        ? null
        : requireTimestamp(input.capturedAt, "Artifact capture time");
    const terminalAssistantMessageId = input.terminalAssistantMessageId === undefined
      ? current.terminalAssistantMessageId
      : optionalTurnString(input.terminalAssistantMessageId, "Artifact terminal message ID", 200);
    if (
      terminalAssistantMessageId
      && terminalAssistantMessageId !== this.agentTurn(turnId).terminalAssistantMessageId
    ) {
      const message = this.database.prepare("SELECT * FROM messages WHERE id = ?")
        .get(terminalAssistantMessageId) as MessageRow | undefined;
      if (!message || message.turn_id !== turnId || message.role !== "assistant") {
        throw new Error("The artifact terminal message does not belong to this turn.");
      }
    }
    const failureReason = input.failureReason === undefined
      ? current.failureReason
      : optionalTurnString(input.failureReason, "Artifact failure reason", 1_000);
    const absenceReason = input.absenceReason === undefined
      ? current.absenceReason ?? null
      : input.absenceReason === "not-repository"
        ? input.absenceReason
        : null;
    this.database.prepare(`
      UPDATE turn_git_artifacts SET
        after_ref = @afterRef,
        after_fingerprint = @afterFingerprint,
        files_json = @filesJson,
        insertions = @insertions,
        deletions = @deletions,
        status = @status,
        completeness = @completeness,
        patch_state = @patchState,
        patch_digest = @patchDigest,
        captured_at = @capturedAt,
        terminal_assistant_message_id = @terminalAssistantMessageId,
        failure_reason = @failureReason,
        absence_reason = @absenceReason,
        updated_at = @updatedAt
      WHERE turn_id = @turnId
    `).run({
      turnId,
      afterRef,
      afterFingerprint,
      filesJson,
      insertions,
      deletions,
      status: input.status,
      completeness: input.completeness,
      patchState: input.patchState ?? current.patchState,
      patchDigest,
      capturedAt,
      terminalAssistantMessageId,
      failureReason,
      absenceReason,
      updatedAt,
    });
    return this.turnGitArtifactStorage(turnId);
  }

  turnGitArtifact(turnId: string): TurnGitArtifact | null {
    const row = this.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    return row ? turnGitArtifactFromRow(row) : null;
  }

  turnGitArtifactStorage(turnId: string): StoredTurnGitArtifact {
    const row = this.database.prepare(
      "SELECT * FROM turn_git_artifacts WHERE turn_id = ?",
    ).get(turnId) as TurnGitArtifactRow | undefined;
    if (!row) throw new RecordNotFoundError("Turn Git artifact not found.");
    return storedTurnGitArtifactFromRow(row);
  }

  pendingTurnGitArtifacts(): StoredTurnGitArtifact[] {
    return (this.database.prepare(`
      SELECT * FROM turn_git_artifacts
      WHERE status = 'pending'
      ORDER BY created_at ASC, id ASC
    `).all() as TurnGitArtifactRow[]).map(storedTurnGitArtifactFromRow);
  }

  turnGitPatchDigests(): Set<string> {
    return new Set((this.database.prepare(`
      SELECT DISTINCT patch_digest AS digest
      FROM turn_git_artifacts
      WHERE patch_digest IS NOT NULL AND patch_state IN ('available', 'truncated')
    `).all() as Array<{ digest: string }>).map(({ digest }) => digest));
  }

  expireTurnGitPatch(digest: string): void {
    const validated = optionalSha256(digest, "Artifact patch digest");
    this.database.prepare(`
      UPDATE turn_git_artifacts
      SET patch_state = 'expired', updated_at = ?
      WHERE patch_digest = ? AND patch_state IN ('available', 'truncated')
    `).run(new Date().toISOString(), validated);
  }

  updateAgentTurnLifecycle(turnId: string, update: AgentTurnLifecycleUpdate): AgentTurn {
    const current = agentTurnFromRow(this.requireAgentTurn(turnId));
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
      terminalMessage = this.database.prepare("SELECT * FROM messages WHERE id = ?").get(terminalAssistantMessageId) as MessageRow | undefined;
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
    const updateTurn = this.database.prepare(`
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
    this.database.transaction(() => {
      const result = updateTurn.run({ ...next, usageCompletionJson, previousStatus: current.status });
      if (result.changes !== 1) {
        throw new Error("Agent turn lifecycle changed concurrently or was already settled.");
      }
      if (terminalMessage) {
        this.database.prepare("UPDATE messages SET turn_id = ? WHERE id = ?").run(current.id, terminalMessage.id);
      }
    })();
    return next;
  }

  /**
   * Atomically wins one terminal outcome. Callers losing a completion/cancel/
   * process-exit race receive the already-authoritative turn without changing
   * its status, timestamps, reason, session, message, checkpoint, or usage.
   */
  settleAgentTurn(turnId: string, update: AgentTurnSettlementUpdate): AgentTurnSettlementResult {
    const current = this.agentTurn(turnId);
    if (isAgentTurnTerminalStatus(current.status)) return { settled: false, turn: current };
    try {
      return {
        settled: true,
        turn: this.updateAgentTurnLifecycle(turnId, update),
      };
    } catch (error) {
      const latest = this.agentTurn(turnId);
      if (isAgentTurnTerminalStatus(latest.status)) return { settled: false, turn: latest };
      throw error;
    }
  }

  settleConversation(conversationId: string, settled: boolean): Conversation {
    return this.conversationRepository.settle(conversationId, settled);
  }

  archiveConversation(conversationId: string, archived: boolean): void {
    this.conversationRepository.archive(conversationId, archived);
  }

  deleteConversation(conversationId: string): void {
    this.conversationRepository.delete(conversationId);
  }

  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"] = "user",
    attachments: ChatAttachment[] = [],
    turnId: string | null = null,
    createdAt?: string,
  ): ChatMessage {
    return this.transcriptRepository.createMessage(
      conversationId,
      content,
      role,
      attachments,
      turnId,
      createdAt,
    );
  }

  createFollowUpMessage(
    conversationId: string,
    turnId: string,
    content: string,
    createdAt?: string,
  ): ChatMessage {
    return this.transcriptRepository.createFollowUpMessage(
      conversationId,
      turnId,
      content,
      createdAt,
    );
  }

  deleteFollowUpMessage(
    messageId: string,
    conversationId: string,
    turnId: string,
  ): boolean {
    return this.transcriptRepository.deleteFollowUpMessage(
      messageId,
      conversationId,
      turnId,
    );
  }

  associateMessageWithTurn(messageId: string, conversationId: string, runId: string, turnId: string): ChatMessage {
    return this.transcriptRepository.associateMessageWithTurn(
      messageId,
      conversationId,
      runId,
      turnId,
    );
  }

  updateMessageContent(messageId: string, content: string): void {
    this.transcriptRepository.updateMessageContent(messageId, content);
  }

  upsertAgentPlan(plan: AgentPlan): void {
    this.requireConversation(plan.conversationId);
    if (plan.turnId) this.assertAgentTurnIdentity(plan.conversationId, plan.runId, plan.turnId);
    this.database.prepare(`
      INSERT INTO agent_plans (conversation_id, run_id, turn_id, explanation, steps_json, updated_at)
      VALUES (@conversationId, @runId, @turnId, @explanation, @stepsJson, @updatedAt)
      ON CONFLICT(conversation_id, run_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        explanation = excluded.explanation,
        steps_json = excluded.steps_json,
        updated_at = excluded.updated_at
    `).run({
      conversationId: plan.conversationId,
      runId: plan.runId,
      turnId: plan.turnId,
      explanation: plan.explanation,
      stepsJson: JSON.stringify(plan.steps.slice(0, 50)),
      updatedAt: new Date().toISOString(),
    });
  }

  clearAgentPlan(conversationId: string, runId: string, turnId: string | null): void {
    this.requireConversation(conversationId);
    if (turnId) this.assertAgentTurnIdentity(conversationId, runId, turnId);
    this.database.prepare(`
      DELETE FROM agent_plans
      WHERE conversation_id = ? AND run_id = ? AND turn_id IS ?
    `).run(conversationId, runId, turnId);
  }

  addActivity(
    activity: Omit<AgentActivity, "id" | "createdAt" | "turnId"> & {
      turnId?: string | null;
      createdAt?: string;
    },
  ): AgentActivity {
    this.requireConversation(activity.conversationId);
    const turnId = activity.turnId ?? null;
    if (turnId) this.assertAgentTurnIdentity(activity.conversationId, activity.runId, turnId);
    const record: AgentActivity = {
      ...activity,
      turnId,
      id: randomUUID(),
      createdAt: activity.createdAt ?? new Date().toISOString(),
    };
    this.database.prepare(`INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at) VALUES (@id, @conversationId, @runId, @turnId, @kind, @title, @detail, @status, @createdAt)`).run(record);
    return record;
  }

  updateActivity(id: string, update: Partial<Pick<AgentActivity, "title" | "detail" | "status">>): AgentActivity {
    const row = this.database.prepare("SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | undefined;
    if (!row) throw new RecordNotFoundError("Activity not found.");
    const next = { ...activityFromRow(row), ...update };
    this.database.prepare("UPDATE activities SET title = ?, detail = ?, status = ? WHERE id = ?").run(next.title, next.detail, next.status, id);
    return next;
  }

  subagentTrace(traceId: string): SubagentTrace {
    const row = this.database.prepare(
      "SELECT * FROM subagent_traces WHERE id = ?",
    ).get(traceId) as SubagentTraceRow | undefined;
    if (!row) throw new RecordNotFoundError("Delegated task not found.");
    return subagentTraceFromRow(row);
  }

  upsertSubagentTrace(
    input: UpsertSubagentTraceInput,
  ): UpsertSubagentTraceResult | null {
    this.assertAgentTurnIdentity(input.conversationId, input.runId, input.turnId);
    const providerTaskId = boundedSubagentIdentifier(input.providerTaskId);
    const providerAgentId = boundedSubagentIdentifier(input.providerAgentId);
    if (!providerTaskId && !providerAgentId) return null;
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) return null;
    const identityParams = [
      input.conversationId,
      input.runId,
      input.providerId,
    ] as const;
    const byTask = providerTaskId
      ? this.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_task_id = ?
        `).get(...identityParams, providerTaskId) as SubagentTraceRow | undefined
      : undefined;
    const byAgent = providerAgentId
      ? this.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_agent_id = ?
        `).get(...identityParams, providerAgentId) as SubagentTraceRow | undefined
      : undefined;
    if (byTask && byAgent && byTask.id !== byAgent.id) return null;
    const providerToolUseId = boundedSubagentIdentifier(input.providerToolUseId);
    const byToolUse = !byTask && !byAgent && providerToolUseId
      ? this.database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_tool_use_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, providerToolUseId) as SubagentTraceRow | undefined
      : undefined;
    const existing = byTask ?? byAgent ?? byToolUse;
    if (existing && input.sequence <= existing.sequence) {
      return { trace: subagentTraceFromRow(existing), changed: false };
    }
    if (
      existing
      && isTerminalSubagentStatus(existing.status)
      && !isTerminalSubagentStatus(input.status)
    ) {
      return { trace: subagentTraceFromRow(existing), changed: false };
    }

    const parentProviderAgentId = boundedSubagentIdentifier(
      input.parentProviderAgentId,
    );
    const parentProviderToolUseId = boundedSubagentIdentifier(
      input.parentProviderToolUseId,
    );
    const parentByAgent = parentProviderAgentId
      ? this.database.prepare(`
          SELECT id FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_agent_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, parentProviderAgentId) as { id: string } | undefined
      : undefined;
    const parentByToolUse = !parentByAgent && parentProviderToolUseId
      ? this.database.prepare(`
          SELECT id FROM subagent_traces
          WHERE conversation_id = ? AND run_id = ? AND provider_id = ?
            AND provider_tool_use_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get(...identityParams, parentProviderToolUseId) as { id: string } | undefined
      : undefined;
    const parent = parentByAgent ?? parentByToolUse;
    const now = input.updatedAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(input.updatedAt, "Delegated task update time");
    const normalized = {
      providerTaskId,
      providerAgentId,
      parentTraceId: parent?.id ?? null,
      parentProviderAgentId,
      parentProviderToolUseId,
      providerToolUseId,
      providerRole: boundedSubagentIdentifier(input.providerRole, 200),
      providerName: boundedSubagentIdentifier(input.providerName, 200),
      description: boundedSubagentText(
        input.description,
        MAX_SUBAGENT_DESCRIPTION_CHARS,
      ),
      progress: boundedSubagentText(
        input.progress,
        MAX_SUBAGENT_PROGRESS_CHARS,
      ),
      result: boundedSubagentText(input.result, MAX_SUBAGENT_RESULT_CHARS),
    };

    if (existing) {
      this.database.prepare(`
        UPDATE subagent_traces
        SET provider_task_id = COALESCE(@providerTaskId, provider_task_id),
            provider_agent_id = COALESCE(@providerAgentId, provider_agent_id),
            parent_trace_id = COALESCE(@parentTraceId, parent_trace_id),
            parent_provider_agent_id = COALESCE(
              @parentProviderAgentId,
              parent_provider_agent_id
            ),
            parent_provider_tool_use_id = COALESCE(
              @parentProviderToolUseId,
              parent_provider_tool_use_id
            ),
            provider_tool_use_id = COALESCE(
              @providerToolUseId,
              provider_tool_use_id
            ),
            provider_role = COALESCE(@providerRole, provider_role),
            provider_name = COALESCE(@providerName, provider_name),
            status = @status,
            description = COALESCE(@description, description),
            progress = COALESCE(@progress, progress),
            result = COALESCE(@result, result),
            sequence = @sequence,
            updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id: existing.id,
        ...normalized,
        status: input.status,
        sequence: input.sequence,
        updatedAt: now < existing.updated_at ? existing.updated_at : now,
      });
      this.linkSubagentChildren(existing.id);
      return {
        trace: this.subagentTrace(existing.id),
        changed: true,
      };
    }

    const count = (this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM subagent_traces
      WHERE turn_id = ?
    `).get(input.turnId) as { count: number }).count;
    if (count >= MAX_SUBAGENT_TRACES_PER_TURN) return null;
    const trace: SubagentTrace = {
      id: randomUUID(),
      conversationId: input.conversationId,
      runId: input.runId,
      turnId: input.turnId,
      providerId: input.providerId,
      ...normalized,
      status: input.status,
      sequence: input.sequence,
      createdAt: now,
      updatedAt: now,
    };
    this.database.prepare(`
      INSERT INTO subagent_traces (
        id, conversation_id, run_id, turn_id, provider_id,
        provider_task_id, provider_agent_id, parent_trace_id,
        parent_provider_agent_id, parent_provider_tool_use_id,
        provider_tool_use_id, provider_role,
        provider_name, status, description, progress, result, sequence,
        created_at, updated_at
      ) VALUES (
        @id, @conversationId, @runId, @turnId, @providerId,
        @providerTaskId, @providerAgentId, @parentTraceId,
        @parentProviderAgentId, @parentProviderToolUseId,
        @providerToolUseId, @providerRole,
        @providerName, @status, @description, @progress, @result, @sequence,
        @createdAt, @updatedAt
      )
    `).run(trace);
    this.linkSubagentChildren(trace.id);
    return { trace, changed: true };
  }

  settleLiveSubagents(
    turnId: string,
    status: Extract<SubagentTraceStatus, "cancelled" | "lost">,
    updatedAt = new Date().toISOString(),
  ): SubagentTrace[] {
    const now = requireTimestamp(updatedAt, "Delegated task settlement time");
    const rows = this.database.prepare(`
      SELECT * FROM subagent_traces
      WHERE turn_id = ?
        AND status IN ('spawned', 'running', 'waiting')
      ORDER BY created_at ASC, sequence ASC, id ASC
    `).all(turnId) as SubagentTraceRow[];
    if (rows.length === 0) return [];
    const update = this.database.prepare(`
      UPDATE subagent_traces
      SET status = ?, sequence = sequence + 1, updated_at = ?
      WHERE id = ?
        AND status IN ('spawned', 'running', 'waiting')
    `);
    this.database.transaction(() => {
      for (const row of rows) update.run(status, now, row.id);
    })();
    return rows.map(({ id }) => this.subagentTrace(id));
  }

  createReasoning(conversationId: string, runId: string, turnId: string | null = null): AgentReasoning {
    this.requireConversation(conversationId);
    if (turnId) this.assertAgentTurnIdentity(conversationId, runId, turnId);
    const reasoning: AgentReasoning = {
      id: randomUUID(),
      conversationId,
      runId,
      turnId,
      content: "",
      status: "running",
      createdAt: new Date().toISOString(),
    };
    this.database.prepare(`INSERT INTO agent_reasonings (id, conversation_id, run_id, turn_id, content, status, created_at) VALUES (@id, @conversationId, @runId, @turnId, @content, @status, @createdAt)`).run(reasoning);
    return reasoning;
  }

  updateReasoning(id: string, update: Partial<Pick<AgentReasoning, "content" | "status">>): AgentReasoning {
    const row = this.database.prepare("SELECT * FROM agent_reasonings WHERE id = ?").get(id) as AgentReasoningRow | undefined;
    if (!row) throw new RecordNotFoundError("Reasoning summary not found.");
    const next = { ...reasoningFromRow(row), ...update };
    this.database.prepare("UPDATE agent_reasonings SET content = ?, status = ? WHERE id = ?").run(next.content, next.status, id);
    return next;
  }

  upsertUsage(
    usage: Omit<ThreadUsageSnapshot, "updatedAt" | "turnId"> & { turnId?: string | null },
  ): ThreadUsageSnapshot {
    this.requireConversation(usage.conversationId);
    const turnId = usage.turnId ?? null;
    if (turnId) {
      const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
      if (turn.conversationId !== usage.conversationId) {
        throw new Error("The usage snapshot turn belongs to a different conversation.");
      }
    }
    const next: ThreadUsageSnapshot = {
      conversationId: usage.conversationId,
      turnId,
      ...validateProviderUsage(usage),
      updatedAt: new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT INTO thread_usage (conversation_id, turn_id, used_tokens, total_processed_tokens, total_processed_scope, max_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, compacts_automatically, updated_at)
      VALUES (@conversationId, @turnId, @usedTokens, @totalProcessedTokens, @totalProcessedScope, @maxTokens, @inputTokens, @cachedInputTokens, @cacheWriteInputTokens, @outputTokens, @reasoningOutputTokens, @compactsAutomatically, @updatedAt)
      ON CONFLICT(conversation_id) DO UPDATE SET
        turn_id = excluded.turn_id,
        used_tokens = excluded.used_tokens,
        total_processed_tokens = excluded.total_processed_tokens,
        total_processed_scope = excluded.total_processed_scope,
        max_tokens = excluded.max_tokens,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_write_input_tokens = excluded.cache_write_input_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        compacts_automatically = excluded.compacts_automatically,
        updated_at = excluded.updated_at
    `).run({ ...next, compactsAutomatically: next.compactsAutomatically === null ? null : Number(next.compactsAutomatically) });
    return next;
  }

  usageForConversation(conversationId: string): ThreadUsageSnapshot | null {
    this.requireConversation(conversationId);
    const row = this.database.prepare(
      "SELECT * FROM thread_usage WHERE conversation_id = ?",
    ).get(conversationId) as ThreadUsageRow | undefined;
    return row ? usageFromRow(row) : null;
  }

  checkpointCount(conversationId: string): number {
    this.requireConversation(conversationId);
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM checkpoints WHERE conversation_id = ?",
    ).get(conversationId) as { count: number };
    return row.count;
  }

  addCheckpoint(
    input: Omit<CheckpointSummary, "id" | "createdAt" | "turnId"> & { turnId?: string | null },
  ): CheckpointSummary {
    this.requireConversation(input.conversationId);
    const turnId = input.turnId ?? null;
    if (turnId) {
      const turn = agentTurnFromRow(this.requireAgentTurn(turnId));
      if (turn.conversationId !== input.conversationId) {
        throw new Error("The checkpoint turn belongs to a different conversation.");
      }
    }
    const checkpoint: CheckpointSummary = { ...input, turnId, id: randomUUID(), createdAt: new Date().toISOString() };
    this.database.prepare(`INSERT INTO checkpoints (id, conversation_id, turn_id, ref, label, turn_index, files_changed, insertions, deletions, created_at) VALUES (@id, @conversationId, @turnId, @ref, @label, @turnIndex, @filesChanged, @insertions, @deletions, @createdAt)`).run(checkpoint);
    return checkpoint;
  }

  associateCheckpointWithTurn(checkpointId: string, conversationId: string, runId: string, turnId: string): CheckpointSummary {
    this.assertAgentTurnIdentity(conversationId, runId, turnId);
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (!row || row.conversation_id !== conversationId) throw new RecordNotFoundError("Checkpoint not found.");
    if (row.turn_id !== null && row.turn_id !== turnId) {
      throw new Error("The checkpoint is already owned by a different turn.");
    }
    if (row.turn_id === null) this.database.prepare("UPDATE checkpoints SET turn_id = ? WHERE id = ?").run(turnId, checkpointId);
    return { ...checkpointFromRow(row), turnId };
  }

  upsertReviewSummary(summary: DiffReviewSummary): DiffReviewSummary {
    return this.reviewRepository.upsertSummary(summary);
  }

  setReviewState(input: Omit<DiffReviewState, "stale" | "updatedAt">): DiffReviewState {
    return this.reviewRepository.setState(input);
  }

  createReviewNote(input: Omit<DiffReviewNote, "id" | "stale" | "createdAt" | "updatedAt">): DiffReviewNote {
    return this.reviewRepository.createNote(input);
  }

  updateReviewNote(conversationId: string, noteId: string, body: string): DiffReviewNote {
    return this.reviewRepository.updateNote(conversationId, noteId, body);
  }

  deleteReviewNote(conversationId: string, noteId: string): void {
    this.reviewRepository.deleteNote(conversationId, noteId);
  }

  reviewNotesFor(conversationId: string): DiffReviewNote[] {
    return this.reviewRepository.notesFor(conversationId);
  }

  reconcileReviewTargets(
    conversationId: string,
    targets: {
      files: Readonly<Record<string, string>>;
      hunks: Readonly<Record<string, string>>;
      notes: Readonly<Record<string, string | null>>;
    },
  ): void {
    this.reviewRepository.reconcileTargets(conversationId, targets);
  }

  createWorkspaceRun(
    input: Omit<WorkspaceRun, "id" | "actionId" | "attentionState" | "canStop" | "startedAt" | "finishedAt"> & {
      id?: string;
      actionId?: string | null;
      attentionState?: WorkspaceRun["attentionState"];
    },
  ): WorkspaceRun {
    return this.workspaceRunRepository.create(input);
  }

  updateWorkspaceRun(id: string, update: Partial<Pick<WorkspaceRun, "label" | "detail" | "status" | "port" | "finishedAt">>): WorkspaceRun {
    return this.workspaceRunRepository.update(id, update);
  }

  workspaceRun(id: string): WorkspaceRun {
    return this.workspaceRunRepository.get(id);
  }

  hasActiveWorkspaceRunForProject(projectId: string): boolean {
    return this.workspaceRunRepository.hasActiveForProject(projectId);
  }

  hasActiveWorkspaceRunForConversation(conversationId: string): boolean {
    return this.workspaceRunRepository.hasActiveForConversation(conversationId);
  }

  markWorkspaceRunSeen(id: string): WorkspaceRun {
    return this.workspaceRunRepository.markSeen(id);
  }

  acknowledgeWorkspaceRun(id: string): WorkspaceRun {
    return this.workspaceRunRepository.acknowledge(id);
  }

  dismissWorkspaceRun(id: string): void {
    this.workspaceRunRepository.dismiss(id);
  }

  checkpoint(checkpointId: string): CheckpointSummary {
    const row = this.database.prepare("SELECT * FROM checkpoints WHERE id = ?").get(checkpointId) as CheckpointRow | undefined;
    if (!row) throw new RecordNotFoundError("Checkpoint not found.");
    return checkpointFromRow(row);
  }

  listModelBackendProfiles(): StoredModelBackendProfile[] {
    return this.backendProfileRepository.listProfiles();
  }

  modelBackendProfile(profileId: string): StoredModelBackendProfile {
    return this.backendProfileRepository.profile(profileId);
  }

  saveModelBackendProfile(
    profileInput: PersistedModelBackendProfile,
  ): StoredModelBackendProfile {
    return this.backendProfileRepository.saveProfile(profileInput);
  }

  reconcileModelBackendCredentialGeneration(
    profileId: string,
    credentialGeneration: string | null,
  ): StoredModelBackendProfile {
    return this.backendProfileRepository.reconcileCredentialGeneration(
      profileId,
      credentialGeneration,
    );
  }

  recordModelBackendProbe(
    profileId: string,
    resultInput: BackendCompatibilityProbeResult,
  ): StoredModelBackendProfile {
    return this.backendProfileRepository.recordProbe(profileId, resultInput);
  }

  deleteModelBackendProfile(profileId: string): void {
    this.backendProfileRepository.deleteProfile(profileId);
  }

  listModelBackendDefaults(): ModelBackendDefault[] {
    return this.backendProfileRepository.listDefaults();
  }

  saveModelBackendDefault(
    projectId: string | null,
    selectionInput: ModelSelection,
  ): ModelBackendDefault {
    return this.backendProfileRepository.saveDefault(projectId, selectionInput);
  }

  clearModelBackendDefault(projectId: string | null): void {
    this.backendProfileRepository.clearDefault(projectId);
  }

  updateSettings(update: Partial<AppSettings>): void {
    this.settingsRepository.update(update);
  }

  project(projectId: string): Project {
    return this.projectRepository.get(projectId);
  }

  conversation(conversationId: string): Conversation {
    return this.conversationRepository.get(conversationId);
  }

  projectPath(projectId: string): string {
    return this.projectRepository.path(projectId);
  }

  conversationPath(conversationId: string): string {
    return this.conversationRepository.path(conversationId);
  }

  private touchProject(projectId: string, timestamp: string): void {
    this.projectRepository.touch(projectId, timestamp);
  }

  private requireProject(projectId: string): ProjectRow {
    const project = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!project) throw new RecordNotFoundError("Project not found.");
    return project;
  }

  private requireConversation(conversationId: string): ConversationRow {
    const conversation = this.database.prepare("SELECT * FROM conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
    if (!conversation) throw new RecordNotFoundError("Conversation not found.");
    return conversation;
  }

  private requireAgentTurn(turnId: string): AgentTurnRow {
    const turn = this.database.prepare("SELECT * FROM agent_turns WHERE id = ?").get(turnId) as AgentTurnRow | undefined;
    if (!turn) throw new RecordNotFoundError("Agent turn not found.");
    return turn;
  }

  private linkSubagentChildren(parentTraceId: string): void {
    const parent = this.database.prepare(`
      SELECT conversation_id, run_id, provider_id, provider_agent_id,
             provider_tool_use_id
      FROM subagent_traces
      WHERE id = ?
    `).get(parentTraceId) as Pick<
      SubagentTraceRow,
      | "conversation_id"
      | "run_id"
      | "provider_id"
      | "provider_agent_id"
      | "provider_tool_use_id"
    > | undefined;
    if (!parent) return;
    this.database.prepare(`
      UPDATE subagent_traces
      SET parent_trace_id = ?
      WHERE id <> ?
        AND conversation_id = ?
        AND run_id = ?
        AND provider_id = ?
        AND parent_trace_id IS NULL
        AND (
          (
            ? IS NOT NULL
            AND parent_provider_agent_id = ?
          )
          OR
          (
            ? IS NOT NULL
            AND parent_provider_tool_use_id = ?
          )
        )
    `).run(
      parentTraceId,
      parentTraceId,
      parent.conversation_id,
      parent.run_id,
      parent.provider_id,
      parent.provider_agent_id,
      parent.provider_agent_id,
      parent.provider_tool_use_id,
      parent.provider_tool_use_id,
    );
  }

  private migrate(): void {
    const legacyMigrations: DatabaseMigrationDefinition[] = LEGACY_SCHEMA_SQL.map(
      (sql, index) => {
      const version = index + 1;
      return {
        name: version === 17 ? "ExplicitTurnOwnership" : `SchemaVersion${version}`,
        up: version === 17
          ? (database) => {
            this.ensureTurnAssociationColumns();
            database.exec(sql);
          }
          : sql,
      };
    });
    const migrationExtensions: DatabaseMigrationDefinition[] = [];
    migrationExtensions.push({
      name: "BackfillLegacyAgentTurns",
      up: (database, context) => {
        context.setLegacyBackfillDiagnostics(backfillLegacyAgentTurns(database, {
          sourceSchemaVersion: context.sourceSchemaVersion,
        }));
      },
    });
    migrationExtensions.push({
      name: "PersistCompleteDiffReviewSummary",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(diff_review_summaries)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "summary_json")) {
          database.exec(`
            ALTER TABLE diff_review_summaries ADD COLUMN summary_json TEXT
              CHECK (summary_json IS NULL OR length(summary_json) <= 524288);
          `);
        }
      },
    });
    migrationExtensions.push({
      name: "PersistWorkspaceRunAttention",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(workspace_runs)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "attention_state")) {
          database.exec(`
            ALTER TABLE workspace_runs ADD COLUMN attention_state TEXT NOT NULL DEFAULT 'acknowledged'
              CHECK (attention_state IN ('unseen', 'seen', 'acknowledged', 'dismissed'));
          `);
        }
        database.prepare(`
          UPDATE workspace_runs
          SET attention_state = CASE
            WHEN status = 'waiting' THEN 'unseen'
            WHEN status = 'failed'
              AND julianday(COALESCE(finished_at, started_at)) < julianday(?) - 1
              THEN 'acknowledged'
            WHEN status = 'failed'
              AND conversation_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM conversations
                WHERE conversations.id = workspace_runs.conversation_id
                  AND conversations.last_viewed_at IS NOT NULL
                  AND julianday(conversations.last_viewed_at)
                    >= julianday(COALESCE(workspace_runs.finished_at, workspace_runs.started_at))
              )
              THEN 'seen'
            WHEN status = 'failed' THEN 'unseen'
            WHEN kind = 'agent' AND status = 'succeeded'
              AND conversation_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM conversations
                WHERE conversations.id = workspace_runs.conversation_id
                  AND conversations.last_viewed_at IS NOT NULL
                  AND julianday(conversations.last_viewed_at)
                    >= julianday(COALESCE(workspace_runs.finished_at, workspace_runs.started_at))
              )
              THEN 'seen'
            WHEN kind = 'agent' AND status = 'succeeded' THEN 'unseen'
            ELSE 'acknowledged'
          END
        `).run(new Date().toISOString());
        database.exec(`
          CREATE INDEX IF NOT EXISTS workspace_runs_attention_idx
            ON workspace_runs(attention_state, status, started_at DESC);
        `);
      },
    });
    migrationExtensions.push({
      name: "PersistAgentPlansPerTurn",
      up: `
        CREATE TABLE agent_plans_v21 (
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL,
          turn_id TEXT REFERENCES agent_turns(id) ON DELETE SET NULL,
          explanation TEXT,
          steps_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (conversation_id, run_id)
        );
        INSERT INTO agent_plans_v21 (
          conversation_id, run_id, turn_id, explanation, steps_json, updated_at
        )
        SELECT conversation_id, run_id, turn_id, explanation, steps_json, updated_at
        FROM agent_plans;
        DROP TABLE agent_plans;
        ALTER TABLE agent_plans_v21 RENAME TO agent_plans;
        CREATE UNIQUE INDEX agent_plans_turn_id_unique_idx
          ON agent_plans(turn_id) WHERE turn_id IS NOT NULL;
        CREATE INDEX agent_plans_conversation_turn_idx
          ON agent_plans(conversation_id, turn_id);
        CREATE INDEX agent_plans_conversation_updated_idx
          ON agent_plans(conversation_id, updated_at ASC, run_id ASC);
      `,
    });
    migrationExtensions.push({
      name: "PersistBoundedTurnExecutionContext",
      up: `
        CREATE TABLE IF NOT EXISTS turn_execution_context_blobs (
          digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
          byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
          content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) = byte_size),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turn_execution_manifests (
          turn_id TEXT PRIMARY KEY REFERENCES agent_turns(id) ON DELETE CASCADE,
          manifest_json TEXT NOT NULL CHECK (length(manifest_json) BETWEEN 2 AND 65536),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS turn_execution_context_refs (
          turn_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 31),
          digest TEXT NOT NULL REFERENCES turn_execution_context_blobs(digest) ON DELETE RESTRICT,
          kind TEXT NOT NULL CHECK (kind IN ('file', 'diff', 'terminal', 'preview', 'review-note')),
          label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 4096),
          byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 65536),
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          PRIMARY KEY (turn_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS turn_execution_context_refs_digest_idx
          ON turn_execution_context_refs(digest);
        CREATE TRIGGER IF NOT EXISTS turn_execution_context_refs_prune_blob
        AFTER DELETE ON turn_execution_context_refs
        BEGIN
          DELETE FROM turn_execution_context_blobs
          WHERE digest = OLD.digest
            AND NOT EXISTS (
              SELECT 1 FROM turn_execution_context_refs
              WHERE turn_execution_context_refs.digest = OLD.digest
            );
        END;
      `,
    });
    migrationExtensions.push({
      name: "PersistTurnGitArtifacts",
      up: `
        CREATE TABLE IF NOT EXISTS turn_git_artifacts (
          id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
          turn_id TEXT NOT NULL UNIQUE REFERENCES agent_turns(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
          repository_identity TEXT
            CHECK (repository_identity IS NULL OR length(repository_identity) = 64),
          worktree_identity TEXT
            CHECK (worktree_identity IS NULL OR length(worktree_identity) = 64),
          branch TEXT CHECK (branch IS NULL OR length(branch) BETWEEN 1 AND 300),
          before_checkpoint_id TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
          before_ref TEXT CHECK (before_ref IS NULL OR length(before_ref) <= 500),
          after_ref TEXT CHECK (after_ref IS NULL OR length(after_ref) <= 500),
          before_fingerprint TEXT
            CHECK (before_fingerprint IS NULL OR length(before_fingerprint) = 64),
          after_fingerprint TEXT
            CHECK (after_fingerprint IS NULL OR length(after_fingerprint) = 64),
          files_json TEXT NOT NULL DEFAULT '[]' CHECK (length(files_json) <= 262144),
          insertions INTEGER NOT NULL DEFAULT 0 CHECK (insertions >= 0),
          deletions INTEGER NOT NULL DEFAULT 0 CHECK (deletions >= 0),
          status TEXT NOT NULL CHECK (
            status IN ('pending', 'ready', 'partial', 'unavailable', 'failed')
          ),
          completeness TEXT NOT NULL CHECK (
            completeness IN ('complete', 'truncated', 'partial', 'unavailable')
          ),
          patch_state TEXT NOT NULL CHECK (
            patch_state IN ('none', 'available', 'truncated', 'expired', 'failed')
          ),
          patch_digest TEXT CHECK (patch_digest IS NULL OR length(patch_digest) = 64),
          captured_at TEXT,
          terminal_assistant_message_id TEXT,
          failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) <= 1000),
          absence_reason TEXT CHECK (
            absence_reason IS NULL OR absence_reason = 'not-repository'
          ),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (created_at <= updated_at),
          CHECK (
            patch_state NOT IN ('available', 'truncated') OR patch_digest IS NOT NULL
          )
        );
        CREATE INDEX IF NOT EXISTS turn_git_artifacts_conversation_created_idx
          ON turn_git_artifacts(conversation_id, created_at ASC, id ASC);
        CREATE INDEX IF NOT EXISTS turn_git_artifacts_repository_worktree_idx
          ON turn_git_artifacts(repository_identity, worktree_identity, created_at ASC);
        CREATE INDEX IF NOT EXISTS turn_git_artifacts_patch_digest_idx
          ON turn_git_artifacts(patch_digest) WHERE patch_digest IS NOT NULL;
      `,
    });
    migrationExtensions.push({
      name: "PersistTurnModelSelection",
      up: (database) => {
        const addColumn = (
          table: "conversations" | "agent_turns",
          column: "model_selection_json" | "continuation_identity_json",
          maximum: number,
        ): void => {
          const columns = database.prepare(`PRAGMA table_info(${table})`)
            .all() as Array<{ name: string }>;
          if (columns.some(({ name }) => name === column)) return;
          database.exec(`
            ALTER TABLE ${table} ADD COLUMN ${column} TEXT
              CHECK (${column} IS NULL OR length(${column}) <= ${maximum});
          `);
        };
        addColumn("conversations", "model_selection_json", 65_536);
        addColumn("conversations", "continuation_identity_json", 4_096);
        addColumn("agent_turns", "model_selection_json", 65_536);
        addColumn("agent_turns", "continuation_identity_json", 4_096);
        const updateConversation = database.prepare(`
          UPDATE conversations
          SET model_selection_json = ?,
              continuation_identity_json = ?
          WHERE id = ?
        `);
        const conversations = database.prepare(`
          SELECT id, provider_id, model, reasoning_effort, provider_session_id
          FROM conversations
          ORDER BY id
        `).all() as Array<Pick<
          ConversationRow,
          "id" | "provider_id" | "model" | "reasoning_effort" | "provider_session_id"
        >>;
        for (const conversation of conversations) {
          const selection = nativeModelSelection({
            providerId: conversation.provider_id,
            modelId: conversation.model || "provider-default",
            alias: conversation.model || null,
            reasoningEffort: conversation.reasoning_effort || null,
          });
          const continuation = conversation.provider_session_id
            ? continuationIdentityForSelection(selection, null, false)
            : null;
          updateConversation.run(
            JSON.stringify(selection),
            continuation ? JSON.stringify(continuation) : null,
            conversation.id,
          );
        }

        const updateTurn = database.prepare(`
          UPDATE agent_turns
          SET model_selection_json = ?,
              continuation_identity_json = ?
          WHERE id = ?
        `);
        const turns = database.prepare(`
          SELECT id, provider_id, harness_id, backend_profile_id, model, model_alias,
                 reasoning_effort, configuration_revision
          FROM agent_turns
          ORDER BY requested_at, id
        `).all() as Array<Pick<
          AgentTurnRow,
          | "id"
          | "provider_id"
          | "harness_id"
          | "backend_profile_id"
          | "model"
          | "model_alias"
          | "reasoning_effort"
          | "configuration_revision"
        >>;
        for (const turn of turns) {
          const selection = legacyModelSelection({
            providerId: turn.provider_id,
            harnessId: turn.harness_id,
            backendProfileId: turn.backend_profile_id,
            model: turn.model,
            modelAlias: turn.model_alias,
            reasoningEffort: turn.reasoning_effort,
            configurationRevision: turn.configuration_revision,
          });
          updateTurn.run(
            JSON.stringify(selection),
            JSON.stringify(continuationIdentityForSelection(selection)),
            turn.id,
          );
        }
      },
    });
    migrationExtensions.push({
      name: "PersistModelBackendProfiles",
      up: `
        CREATE TABLE IF NOT EXISTS model_backend_profiles (
          profile_id TEXT PRIMARY KEY CHECK (length(profile_id) BETWEEN 1 AND 200),
          harness_id TEXT NOT NULL CHECK (
            harness_id IN (
              'codex-app-server', 'codex-cli', 'claude-agent-sdk', 'claude-cli',
              'cursor-acp', 'cursor-cli', 'opencode-sdk', 'opencode-cli'
            )
          ),
          preset TEXT NOT NULL CHECK (preset IN ('native', 'kimi-code', 'custom')),
          protocol TEXT NOT NULL CHECK (
            protocol IN (
              'openai-responses', 'anthropic-messages',
              'cursor-managed', 'opencode-native'
            )
          ),
          source TEXT NOT NULL CHECK (source IN ('built-in', 'custom')),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          configuration_revision INTEGER NOT NULL
            CHECK (configuration_revision >= 0),
          endpoint_identity TEXT
            CHECK (
              endpoint_identity IS NULL
              OR length(endpoint_identity) BETWEEN 1 AND 256
            ),
          credential_generation TEXT
            CHECK (
              credential_generation IS NULL
              OR length(credential_generation) BETWEEN 1 AND 200
            ),
          configuration_json TEXT NOT NULL
            CHECK (length(configuration_json) BETWEEN 2 AND 262144),
          latest_probe_json TEXT
            CHECK (latest_probe_json IS NULL OR length(latest_probe_json) <= 262144),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (created_at <= updated_at)
        );
        CREATE INDEX IF NOT EXISTS model_backend_profiles_harness_idx
          ON model_backend_profiles(harness_id, enabled, updated_at DESC);

        CREATE TABLE IF NOT EXISTS model_backend_defaults (
          scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          selection_json TEXT NOT NULL CHECK (length(selection_json) BETWEEN 2 AND 65536),
          updated_at TEXT NOT NULL,
          CHECK (
            (scope = 'global' AND project_id IS NULL)
            OR (scope = 'project' AND project_id IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS model_backend_defaults_global_unique_idx
          ON model_backend_defaults(scope) WHERE scope = 'global';
        CREATE UNIQUE INDEX IF NOT EXISTS model_backend_defaults_project_unique_idx
          ON model_backend_defaults(project_id) WHERE scope = 'project';
      `,
    });
    migrationExtensions.push({
      name: "ScopeProviderMetadataByExecutionIdentity",
      up: (database) => {
        database.exec(`
          CREATE TABLE IF NOT EXISTS provider_metadata_scoped_cache (
            scope_key TEXT PRIMARY KEY CHECK (length(scope_key) BETWEEN 2 AND 8192),
            provider_id TEXT NOT NULL CHECK (
              provider_id IN ('codex', 'claude', 'cursor', 'opencode')
            ),
            harness_id TEXT NOT NULL CHECK (
              harness_id IN (
                'codex-app-server', 'codex-cli', 'claude-agent-sdk', 'claude-cli',
                'cursor-acp', 'cursor-cli', 'opencode-sdk', 'opencode-cli'
              )
            ),
            backend_profile_id TEXT NOT NULL
              CHECK (length(backend_profile_id) BETWEEN 1 AND 200),
            model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 300),
            executable TEXT CHECK (executable IS NULL OR length(executable) <= 4096),
            version TEXT CHECK (version IS NULL OR length(version) <= 200),
            backend_configuration_revision INTEGER NOT NULL
              CHECK (backend_configuration_revision >= 0),
            auth_state TEXT NOT NULL CHECK (
              auth_state IN (
                'checking', 'authenticated', 'unauthenticated',
                'configured', 'unknown', 'error'
              )
            ),
            models_json TEXT NOT NULL DEFAULT '[]'
              CHECK (length(models_json) <= 262144),
            models_updated_at TEXT,
            models_last_attempted_at TEXT,
            models_provenance TEXT CHECK (
              models_provenance IS NULL
              OR models_provenance IN ('provider', 'session', 'persistent-cache')
            ),
            models_stale INTEGER NOT NULL DEFAULT 0
              CHECK (models_stale IN (0, 1)),
            rate_limits_json TEXT NOT NULL DEFAULT '[]'
              CHECK (length(rate_limits_json) <= 65536),
            rate_limits_updated_at TEXT,
            rate_limits_last_attempted_at TEXT,
            rate_limits_provenance TEXT CHECK (
              rate_limits_provenance IS NULL
              OR rate_limits_provenance IN ('provider', 'session', 'persistent-cache')
            ),
            rate_limits_stale INTEGER NOT NULL DEFAULT 0
              CHECK (rate_limits_stale IN (0, 1))
          );
          CREATE INDEX IF NOT EXISTS provider_metadata_scoped_identity_idx
            ON provider_metadata_scoped_cache(
              provider_id, harness_id, backend_profile_id, model_id,
              backend_configuration_revision
            );
        `);
        const legacyRows = database.prepare(`
          SELECT *
          FROM provider_metadata_cache
          ORDER BY provider_id
        `).all() as Array<{
          provider_id: ProviderId;
          executable: string | null;
          version: string | null;
          auth_state: PersistedProviderMetadata["scope"]["authState"] | null;
          models_json: string;
          models_updated_at: string | null;
          models_last_attempted_at: string | null;
          models_provenance: PersistedProviderMetadata["modelsProvenance"];
          models_stale: 0 | 1;
          rate_limits_json: string;
          rate_limits_updated_at: string | null;
          rate_limits_last_attempted_at: string | null;
          rate_limits_provenance: PersistedProviderMetadata["rateLimitsProvenance"];
          rate_limits_stale: 0 | 1;
        }>;
        const insert = database.prepare(`
          INSERT OR IGNORE INTO provider_metadata_scoped_cache (
            scope_key, provider_id, harness_id, backend_profile_id, model_id,
            executable, version, backend_configuration_revision, auth_state,
            models_json, models_updated_at, models_last_attempted_at,
            models_provenance, models_stale, rate_limits_json,
            rate_limits_updated_at, rate_limits_last_attempted_at,
            rate_limits_provenance, rate_limits_stale
          ) VALUES (
            @scopeKey, @providerId, @harnessId, @backendProfileId, @modelId,
            @executable, @version, @backendConfigurationRevision, @authState,
            @modelsJson, @modelsUpdatedAt, @modelsLastAttemptedAt,
            @modelsProvenance, @modelsStale, @rateLimitsJson,
            @rateLimitsUpdatedAt, @rateLimitsLastAttemptedAt,
            @rateLimitsProvenance, @rateLimitsStale
          )
        `);
        for (const row of legacyRows) {
          const scope = nativeProviderMetadataScope(row.provider_id, {
            executable: row.executable,
            version: row.version,
            authState: row.auth_state ?? "unknown",
          });
          insert.run({
            scopeKey: providerMetadataScopeKey(scope),
            ...scope,
            modelsJson: row.models_json,
            modelsUpdatedAt: row.models_updated_at,
            modelsLastAttemptedAt: row.models_last_attempted_at,
            modelsProvenance: row.models_provenance,
            modelsStale: row.models_stale,
            rateLimitsJson: row.rate_limits_json,
            rateLimitsUpdatedAt: row.rate_limits_updated_at,
            rateLimitsLastAttemptedAt: row.rate_limits_last_attempted_at,
            rateLimitsProvenance: row.rate_limits_provenance,
            rateLimitsStale: row.rate_limits_stale,
          });
        }
      },
    });
    migrationExtensions.push({
      name: "ClassifyTurnGitArtifactAbsence",
      up: (database) => {
        const columns = database.prepare("PRAGMA table_info(turn_git_artifacts)")
          .all() as Array<{ name: string }>;
        if (!columns.some(({ name }) => name === "absence_reason")) {
          database.exec(`
            ALTER TABLE turn_git_artifacts ADD COLUMN absence_reason TEXT
              CHECK (absence_reason IS NULL OR absence_reason = 'not-repository');
          `);
        }
        database.prepare(`
          UPDATE turn_git_artifacts
          SET absence_reason = 'not-repository'
          WHERE status = 'unavailable'
            AND completeness = 'unavailable'
            AND absence_reason IS NULL
            AND failure_reason IN (
              'This workspace is not a Git repository.',
              'The selected folder is not a Git repository.'
            )
        `).run();
      },
    });
    migrationExtensions.push({
      name: "PersistBoundedSubagentTraces",
      up: `
        CREATE TABLE IF NOT EXISTS subagent_traces (
          id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
          conversation_id TEXT NOT NULL
            REFERENCES conversations(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
          turn_id TEXT NOT NULL
            REFERENCES agent_turns(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL
            CHECK (provider_id IN ('codex', 'claude', 'cursor', 'opencode')),
          provider_task_id TEXT
            CHECK (provider_task_id IS NULL OR length(provider_task_id) BETWEEN 1 AND 1000),
          provider_agent_id TEXT
            CHECK (provider_agent_id IS NULL OR length(provider_agent_id) BETWEEN 1 AND 1000),
          parent_trace_id TEXT
            REFERENCES subagent_traces(id) ON DELETE SET NULL,
          parent_provider_agent_id TEXT
            CHECK (parent_provider_agent_id IS NULL OR length(parent_provider_agent_id) BETWEEN 1 AND 1000),
          parent_provider_tool_use_id TEXT
            CHECK (parent_provider_tool_use_id IS NULL OR length(parent_provider_tool_use_id) BETWEEN 1 AND 1000),
          provider_tool_use_id TEXT
            CHECK (provider_tool_use_id IS NULL OR length(provider_tool_use_id) BETWEEN 1 AND 1000),
          provider_role TEXT
            CHECK (provider_role IS NULL OR length(provider_role) BETWEEN 1 AND 200),
          provider_name TEXT
            CHECK (provider_name IS NULL OR length(provider_name) BETWEEN 1 AND 200),
          status TEXT NOT NULL CHECK (status IN (
            'spawned', 'running', 'waiting', 'completed', 'failed',
            'cancelled', 'lost'
          )),
          description TEXT
            CHECK (description IS NULL OR length(description) BETWEEN 1 AND 4000),
          progress TEXT
            CHECK (progress IS NULL OR length(progress) BETWEEN 1 AND 4000),
          result TEXT
            CHECK (result IS NULL OR length(result) BETWEEN 1 AND 16000),
          sequence INTEGER NOT NULL
            CHECK (sequence BETWEEN 0 AND 2147483647),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (provider_task_id IS NOT NULL OR provider_agent_id IS NOT NULL),
          CHECK (created_at <= updated_at)
        );
        CREATE INDEX IF NOT EXISTS subagent_traces_turn_order_idx
          ON subagent_traces(turn_id, created_at ASC, sequence ASC, id ASC);
        CREATE UNIQUE INDEX IF NOT EXISTS subagent_traces_task_identity_idx
          ON subagent_traces(conversation_id, run_id, provider_id, provider_task_id)
          WHERE provider_task_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS subagent_traces_agent_identity_idx
          ON subagent_traces(conversation_id, run_id, provider_id, provider_agent_id)
          WHERE provider_agent_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS subagent_traces_parent_idx
          ON subagent_traces(parent_trace_id, created_at ASC);
      `,
    });
    const runtimeMigrations = createRuntimeMigrationCatalog(
      legacyMigrations,
      migrationExtensions,
    );
    runDatabaseMigrations(this.database, runtimeMigrations, {
      onDiagnostic: (diagnostic) => {
        if (diagnostic.outcome === "failed") {
          console.error(formatMigrationDiagnostic(diagnostic));
        } else if (
          diagnostic.appliedVersions.length > 0
          && (
            diagnostic.sourceReleases.length > 0
            || (diagnostic.legacyBackfill?.responseGroups ?? 0) > 0
          )
        ) {
          console.info(formatMigrationDiagnostic(diagnostic));
        }
      },
    });
  }

  private ensureTurnAssociationColumns(): void {
    const associations = [
      ["messages", "turn_id"],
      ["activities", "turn_id"],
      ["agent_reasonings", "turn_id"],
      ["agent_plans", "turn_id"],
      ["thread_usage", "turn_id"],
      ["checkpoints", "turn_id"],
    ] as const;
    for (const [table, column] of associations) {
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (columns.some(({ name }) => name === column)) continue;
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT REFERENCES agent_turns(id) ON DELETE SET NULL`);
    }
  }

  private initializeState(): void {
    this.settingsRepository.initialize();
  }

  recoverInterruptedRuns(): void {
    const interrupted = this.database.prepare(`
      SELECT DISTINCT conversations.id
      FROM conversations
      LEFT JOIN agent_turns ON agent_turns.conversation_id = conversations.id
      WHERE conversations.status IN ('running', 'needs-input')
         OR agent_turns.status IN (
           'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input'
         )
    `).all() as Array<{ id: string }>;
    const interruptedRunByConversation = new Map(
      (this.database.prepare(`
        SELECT conversation_id, id
        FROM workspace_runs
        WHERE kind = 'agent'
          AND conversation_id IS NOT NULL
          AND status IN ('running', 'waiting')
        ORDER BY started_at ASC, id ASC
      `).all() as Array<{ conversation_id: string; id: string }>)
        .map(({ conversation_id, id }) => [conversation_id, id] as const),
    );
    const wallClockNow = new Date().toISOString();
    const latestTurnTimestamp = (this.database.prepare(`
      SELECT MAX(updated_at) AS timestamp
      FROM agent_turns
      WHERE status IN (
        'queued', 'starting', 'running', 'waiting-for-approval', 'waiting-for-input'
      )
    `).get() as { timestamp: string | null }).timestamp;
    const now = latestTurnTimestamp && latestTurnTimestamp > wallClockNow
      ? latestTurnTimestamp
      : wallClockNow;
    this.database.prepare(`
      UPDATE workspace_runs
      SET status = 'failed',
          attention_state = 'unseen',
          detail = substr(
            CASE
              WHEN detail IS NULL OR detail = '' THEN 'Interrupted when the local runtime stopped.'
              ELSE detail || ' · Interrupted when the local runtime stopped.'
            END,
            1,
            1000
          ),
          finished_at = ?
      WHERE status IN ('running', 'waiting')
    `).run(now);
    this.database.prepare(`
      UPDATE subagent_traces
      SET status = 'lost',
          sequence = sequence + 1,
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
      WHERE status IN ('spawned', 'running', 'waiting')
        AND turn_id IN (
          SELECT id FROM agent_turns
          WHERE status IN (
            'queued', 'starting', 'running',
            'waiting-for-approval', 'waiting-for-input'
          )
        )
    `).run(now, now);
    if (interrupted.length === 0) return;

    const markConversation = this.database.prepare("UPDATE conversations SET status = 'failed', attention_kind = NULL, updated_at = ? WHERE id = ?");
    const markTurnActivities = this.database.prepare("UPDATE activities SET status = 'failed' WHERE conversation_id = ? AND turn_id = ? AND status = 'running'");
    const markTurnReasonings = this.database.prepare("UPDATE agent_reasonings SET status = 'failed' WHERE conversation_id = ? AND turn_id = ? AND status = 'running'");
    const markLegacyActivities = this.database.prepare("UPDATE activities SET status = 'failed' WHERE conversation_id = ? AND turn_id IS NULL AND status = 'running'");
    const markLegacyReasonings = this.database.prepare("UPDATE agent_reasonings SET status = 'failed' WHERE conversation_id = ? AND turn_id IS NULL AND status = 'running'");
    const markInterruptedTurn = this.database.prepare(`
      UPDATE agent_turns
      SET status = 'interrupted',
          started_at = COALESCE(started_at, requested_at),
          completed_at = ?,
          terminal_reason = COALESCE(terminal_reason, 'runtime-restart'),
          updated_at = ?
      WHERE id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
    `);
    const addRecoveryActivity = this.database.prepare(`
      INSERT INTO activities (id, conversation_id, run_id, turn_id, kind, title, detail, status, created_at)
      VALUES (?, ?, ?, ?, 'error', ?, NULL, 'failed', ?)
    `);
    const explicitTurnForRun = this.database.prepare(`
      SELECT id, conversation_id, run_id
      FROM agent_turns
      WHERE conversation_id = ?
        AND run_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      LIMIT 1
    `);
    const latestExplicitTurn = this.database.prepare(`
      SELECT id, conversation_id, run_id
      FROM agent_turns
      WHERE conversation_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      ORDER BY requested_at DESC, id DESC
      LIMIT 1
    `);
    this.database.transaction(() => {
      for (const { id } of interrupted) {
        markConversation.run(now, id);
        const interruptedRunId = interruptedRunByConversation.get(id);
        const turn = (
          (interruptedRunId
            ? explicitTurnForRun.get(id, interruptedRunId)
            : undefined) as Pick<AgentTurnRow, "id" | "conversation_id" | "run_id"> | undefined
        ) ?? (
          latestExplicitTurn.get(id) as Pick<AgentTurnRow, "id" | "conversation_id" | "run_id"> | undefined
        );
        if (turn) {
          markTurnActivities.run(id, turn.id);
          markTurnReasonings.run(id, turn.id);
          markInterruptedTurn.run(now, now, turn.id);
        } else {
          // Preserve recovery for databases that predate authoritative turn ownership.
          markLegacyActivities.run(id);
          markLegacyReasonings.run(id);
        }
        addRecoveryActivity.run(
          randomUUID(),
          id,
          turn?.run_id ?? `recovery-${randomUUID()}`,
          turn?.id ?? null,
          "The previous run ended when Inertia closed. Send another message to continue.",
          now,
        );
      }
    })();
  }

}
