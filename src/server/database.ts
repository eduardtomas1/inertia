import Database from "better-sqlite3";
import {
  type AgentActivity,
  type AgentGoal,
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
  type ConversationShell,
  type DiffReviewNote,
  type DiffReviewState,
  type DiffReviewSummary,
  type ModelSelection,
  type Project,
  type ProviderInfo,
  type SubagentTrace,
  type SubagentTraceStatus,
  type ThreadUsageSnapshot,
  type TurnGitArtifact,
  type WorkspaceRun,
} from "../shared/contracts";
import type { ModelBackendDefault, PersistedModelBackendProfile } from "../shared/backend-profile-settings";
import type { BackendCompatibilityProbeResult } from "../shared/backend-probe";
import type { PersistedProviderMetadata } from "./provider/metadata";
import type { SanitizedTurnExecutionManifest } from "./runtime/turns/request-context";
import { BackendProfileRepository } from "./persistence/backend-profile-repository";
import { AgentThreadManagementRepository } from "./persistence/agent-thread-management-repository";
import { AgentWorkflowRepository, type NativeAgentGoalMergeResult } from "./persistence/agent-workflow-repository";
import { ConversationRepository } from "./persistence/conversation-repository";
import { ConversationContextPacketRepository } from "./persistence/conversation-context-packet-repository";
import { ConversationWorktreeRepository } from "./persistence/conversation-worktree-repository";
import {
  createDuoConversationsAtomically,
  type DuoConversationPlan,
} from "./persistence/duo-conversation-creation";
import {
  DatabaseBackupManager,
  type DatabaseBackupResult,
  type DatabaseRecoveryReport,
  recoverDatabaseOnStartup,
} from "./persistence/database-recovery";
import { reconcileRecoveryImportJournal } from "./persistence/database-recovery-import";
import {
  DATABASE_RECOVERY_EXPORT_MAX_BYTES,
  type DatabaseRecoveryImportResult,
} from "./persistence/database-export";
import {
  exportDatabaseRecoveryData,
  importDatabaseRecoveryData,
  type DatabaseRecoveryImportOptions,
} from "./persistence/database-recovery-store";
import { RecordNotFoundError } from "./persistence/errors";
import { ExecutionLedgerRepository } from "./persistence/execution-ledger-repository";
import { GitArtifactRepository } from "./persistence/git-artifact-repository";
import { migrateRuntimeDatabase } from "./persistence/migrations/runtime-catalog";
import { ProviderMetadataRepository } from "./persistence/provider-metadata-repository"; import { ProviderRunOwnershipRepository } from "./persistence/provider-run-ownership-repository";
import { ProjectRepository } from "./persistence/project-repository";
import {
  PairedLaunchRepository,
  type PairedLaunchComparisonPlan,
  type PairedLaunchSidePlan,
  type StoredPairedLaunch,
} from "./persistence/paired-launch-repository";
import { RecoveryRepository } from "./persistence/recovery-repository";
import { ReviewRepository } from "./persistence/review-repository";
import { SettingsRepository } from "./persistence/settings-repository";
import { SnapshotRepository } from "./persistence/snapshot-repository";
import { ConversationWorkAuthority, storedConversationWorkspaceResolver } from "./persistence/stored-conversation-workspace";
import { SystemSuspendRepository } from "./persistence/system-suspend-repository";
import { TranscriptRepository } from "./persistence/transcript-repository";
import { TurnLedgerRepository, type DailyWorkRange, type UsageDashboardRange } from "./persistence/turn-ledger-repository";
import { WorkspaceRunRepository } from "./persistence/workspace-run-repository";
import type {
  AgentTurnRow,
  ConversationRow,
  ProjectRow,
} from "./persistence/rows";
import type {
  AgentTurnLifecycleUpdate,
  AgentTurnSettlementResult,
  AgentTurnSettlementUpdate,
  BeginAgentTurnInput,
  CompleteTurnGitArtifactInput,
  CreateAgentTurnInput,
  CreateMessageOptions,
  CreateTurnGitArtifactInput,
  NewConversationOptions,
  RuntimeStoreSnapshot,
  StoredModelBackendProfile,
  StoredTurnGitArtifact,
  UpsertSubagentTraceInput,
  UpsertSubagentTraceResult,
} from "./persistence/types";
import type { WorktreeFilesystemReceipt } from "./worktree-filesystem-identity";

export { RecordNotFoundError } from "./persistence/errors";
export type * from "./database-public-types";

export class RuntimeStore {
  private readonly database: Database.Database;
  private readonly backupManager: DatabaseBackupManager;
  private readonly recoveryReport: DatabaseRecoveryReport;
  private readonly backendProfileRepository: BackendProfileRepository;
  private readonly agentWorkflowRepository: AgentWorkflowRepository;
  readonly agentThreadManagement: AgentThreadManagementRepository;
  private readonly conversationRepository: ConversationRepository;
  readonly contextPackets: ConversationContextPacketRepository;
  readonly conversationWorktrees: ConversationWorktreeRepository;
  private readonly executionLedgerRepository: ExecutionLedgerRepository;
  private readonly gitArtifactRepository: GitArtifactRepository;
  private readonly providerMetadataRepository: ProviderMetadataRepository; readonly providerRunOwnership: ProviderRunOwnershipRepository;
  private readonly projectRepository: ProjectRepository;
  private readonly pairedLaunchRepository: PairedLaunchRepository;
  private readonly recoveryRepository: RecoveryRepository;
  private readonly reviewRepository: ReviewRepository;
  private readonly settingsRepository: SettingsRepository;
  private readonly snapshotRepository: SnapshotRepository;
  readonly systemSuspends: SystemSuspendRepository;
  readonly transcriptRepository: TranscriptRepository;
  private readonly turnLedgerRepository: TurnLedgerRepository;
  private readonly workspaceRunRepository: WorkspaceRunRepository;
  private readonly recoveryExportMaxBytes: number;
  readonly conversationWork = new ConversationWorkAuthority(storedConversationWorkspaceResolver(this));

  constructor(
    databasePath: string,
    _defaultWorkspacePath: string,
    options: {
      onDatabaseBackupCreated?: (result: DatabaseBackupResult) => void;
      canStartDatabaseBackup?: () => boolean;
      databaseBackupQuietGraceMs?: number;
      recoverInterruptedRuns?: boolean;
      recoveryExportMaxBytes?: number;
    } = {},
  ) {
    this.recoveryExportMaxBytes = Math.min(
      DATABASE_RECOVERY_EXPORT_MAX_BYTES,
      Math.max(1, Math.trunc(
        options.recoveryExportMaxBytes ?? DATABASE_RECOVERY_EXPORT_MAX_BYTES,
      )),
    );
    this.recoveryReport = recoverDatabaseOnStartup(databasePath);
    this.database = new Database(databasePath);
    this.backupManager = new DatabaseBackupManager(
      this.database,
      databasePath,
      {
        canStartBackup: options.canStartDatabaseBackup,
        quietGraceMs: options.databaseBackupQuietGraceMs,
        onError: () => {
          console.error("The scheduled database backup failed.");
        },
        onCreated: options.onDatabaseBackupCreated,
      },
    );
    this.backendProfileRepository = new BackendProfileRepository({
      database: this.database,
      requireProject: (projectId) => this.requireProject(projectId),
    });
    this.agentWorkflowRepository = new AgentWorkflowRepository({
      database: this.database,
      requireConversation: (conversationId) =>
        this.requireConversation(conversationId),
    });
    this.agentThreadManagement = new AgentThreadManagementRepository(this.database);
    this.providerMetadataRepository = new ProviderMetadataRepository(this.database); this.providerRunOwnership = new ProviderRunOwnershipRepository(this.database);
    this.pairedLaunchRepository = new PairedLaunchRepository(this.database);
    this.recoveryRepository = new RecoveryRepository(this.database);
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
    this.contextPackets = new ConversationContextPacketRepository({
      database: this.database,
      conversationPath: (conversationId) =>
        this.conversationRepository.path(conversationId),
      requireConversation: (conversationId) =>
        this.requireConversation(conversationId),
      requireProject: (projectId) => this.requireProject(projectId), createUserMessage: (conversationId, content, attachments, options) =>
        this.transcriptRepository.createMessage(
          conversationId, content, "user", attachments, null, undefined, options,
        ),
    });
    this.conversationWorktrees = new ConversationWorktreeRepository(
      this.database,
      (conversationId) => this.requireConversation(conversationId),
    );
    this.reviewRepository = new ReviewRepository({
      database: this.database,
      requireConversation: (conversationId) => this.requireConversation(conversationId),
    });
    this.snapshotRepository = new SnapshotRepository({
      database: this.database,
      contextPackets: (conversationId) => this.contextPackets.list(conversationId),
    });
    this.executionLedgerRepository = new ExecutionLedgerRepository({
      assertAgentTurnIdentity: (conversationId, runId, turnId) =>
        this.assertAgentTurnIdentity(conversationId, runId, turnId),
      conversationPath: (conversationId) =>
        this.conversationRepository.path(conversationId),
      database: this.database,
      requireAgentTurn: (turnId) => this.requireAgentTurn(turnId),
      requireConversation: (conversationId) => this.requireConversation(conversationId),
    });
    this.gitArtifactRepository = new GitArtifactRepository({
      agentTurn: (turnId) => this.agentTurn(turnId),
      checkpoint: (checkpointId) => this.checkpoint(checkpointId),
      database: this.database,
    });
    this.turnLedgerRepository = new TurnLedgerRepository({
      createMessage: (
        conversationId,
        content,
        role,
        attachments,
        turnId,
        createdAt,
        options,
      ) => this.createMessage(
        conversationId,
        content,
        role,
        attachments,
        turnId,
        createdAt,
        options,
      ),
      database: this.database,
      requireAgentTurn: (turnId) => this.requireAgentTurn(turnId),
      requireConversation: (conversationId) => this.requireConversation(conversationId),
    });
    this.systemSuspends = new SystemSuspendRepository(this.database);
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
      this.database.pragma("journal_mode = WAL");
      // NORMAL keeps committed transactions crash-consistent in WAL mode
      // without forcing every streamed update through a full filesystem sync.
      // A sudden host power loss may still lose the newest OS-buffered commits.
      this.database.pragma("synchronous = NORMAL");
      this.database.pragma("cache_size = -16000");
      this.database.pragma("mmap_size = 268435456");
      this.database.pragma("temp_store = MEMORY");
      migrateRuntimeDatabase(this.database);
      this.agentThreadManagement.recoverInterrupted();
      this.contextPackets.recoverInterruptedAgentRequests();
      this.projectRepository.enrollMissingPaths();
      reconcileRecoveryImportJournal(this.database);
      this.initializeState();
      if (options.recoverInterruptedRuns !== false) this.recoverInterruptedRuns();
    } catch (error) {
      if (this.database.open) this.database.close();
      throw error;
    }
  }

  close(): void {
    this.backupManager.stop();
    this.conversationWork.clear();
    if (this.database.open) this.database.close();
  }

  startBackups(): void {
    this.backupManager.start();
  }

  createInitialBackup(options: { quietGraceMs?: number } = {}): Promise<DatabaseBackupResult | null> {
    return this.backupManager.requestInitialBackup(options.quietGraceMs ?? 0);
  }

  createBackup(): Promise<DatabaseBackupResult> {
    return this.backupManager.createBackup();
  }

  databaseRecoveryReport(): DatabaseRecoveryReport {
    return this.recoveryReport;
  }

  databaseBackupStatus(): ReturnType<DatabaseBackupManager["status"]> {
    return this.backupManager.status();
  }

  exportRecoveryData(): string {
    return exportDatabaseRecoveryData(
      this.database,
      this.recoveryExportMaxBytes,
    );
  }

  async importRecoveryData(
    serialized: string,
    authorizedRoot: string,
    options: DatabaseRecoveryImportOptions = {},
  ): Promise<DatabaseRecoveryImportResult> {
    return importDatabaseRecoveryData(
      this.database,
      serialized,
      authorizedRoot,
      {
        createProject: (project, path) =>
          this.createProject(project.name, path).id,
        createConversation: (projectId, conversation) =>
          this.createConversation(projectId, conversation.title, {
            providerId: conversation.providerId,
            model: conversation.model || "provider-default",
            reasoningEffort: conversation.reasoningEffort,
            interactionMode: conversation.interactionMode,
            // Exported authorization is never authoritative on this device.
            accessMode: "supervised",
            activate: false,
          }).id,
        createMessage: (id, conversationId, message) => {
          this.transcriptRepository.createRecoveredMessage(
            id,
            conversationId,
            message.content,
            message.role,
            message.createdAt,
          );
        },
      },
      options,
    );
  }

  reconcileRecoveryImport(): void {
    reconcileRecoveryImportJournal(this.database);
  }

  async backupAndClose(): Promise<void> {
    let backupError: unknown;
    try {
      // Shutdown owns a 2.5s process-wide deadline. Do not begin a full online
      // backup here; cancel any scheduled work and rely on the hourly validated
      // rotation plus WAL crash recovery.
      await this.backupManager.cancelAndWait();
    } catch (error) {
      backupError = error;
    } finally {
      if (this.database.open) this.database.close();
    }
    if (backupError !== undefined) throw backupError;
  }

  snapshot(providers: ProviderInfo[] = []): RuntimeStoreSnapshot {
    return this.snapshotRepository.snapshot(providers);
  }

  get promptPresets() { return this.snapshotRepository.promptPresets; }

  shellSnapshot(providers: ProviderInfo[] = []): AppSnapshot {
    return {
      ...this.snapshotRepository.shellSnapshot(providers),
      databaseBackup: this.backupManager.status(),
    };
  }

  conversationShell(conversationId: string): ConversationShell | null {
    return this.snapshotRepository.conversationShell(conversationId);
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
    update: Partial<Pick<Project, "name" | "groupingMode" | "gitRepositoryLimit" | "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath">>,
  ): Project {
    return this.projectRepository.update(projectId, update);
  }

  removeProject(projectId: string): void {
    this.conversationWorktrees.assertProjectRemovalAllowed(projectId);
    this.projectRepository.remove(projectId);
  }

  selectProject(projectId: string): void {
    this.projectRepository.select(projectId);
  }

  createConversation(projectId: string, title: string, options: NewConversationOptions = {}): Conversation {
    return this.conversationRepository.create(projectId, title, options);
  }

  createPairedConversations(
    launchId: string,
    sides: readonly [DuoConversationPlan, DuoConversationPlan],
    now = new Date().toISOString(),
  ): [Conversation, Conversation] {
    return this.createDuoConversations(launchId, sides, null, now).sides;
  }

  createDuoConversations(
    launchId: string,
    sides: readonly [DuoConversationPlan, DuoConversationPlan],
    comparison: DuoConversationPlan | null,
    now = new Date().toISOString(),
  ) {
    return createDuoConversationsAtomically(
      this.database,
      this.conversationRepository,
      this.pairedLaunchRepository,
      launchId,
      sides,
      comparison,
      now,
    );
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

  updateConversation(conversationId: string, update: Partial<Pick<Conversation, "title" | "providerId" | "modelSelection" | "continuationIdentity" | "model" | "reasoningEffort" | "interactionMode" | "accessMode" | "branch" | "worktreePath" | "providerSessionId" | "status" | "attentionKind" | "pinnedAt" | "snoozedUntil">>): Conversation {
    return this.conversationRepository.update(conversationId, update);
  }

  createAgentTurn(input: CreateAgentTurnInput): AgentTurn {
    return this.turnLedgerRepository.create(input);
  }

  beginAgentTurn(input: BeginAgentTurnInput): { message: ChatMessage; turn: AgentTurn } {
    return this.turnLedgerRepository.begin(input);
  }

  beginPairedAgentTurns(
    launchId: string,
    inputs: readonly [BeginAgentTurnInput, BeginAgentTurnInput],
    now = new Date().toISOString(),
  ): [
    { message: ChatMessage; turn: AgentTurn },
    { message: ChatMessage; turn: AgentTurn },
  ] {
    return this.database.transaction(() => {
      const queued = inputs.map((input) => this.turnLedgerRepository.begin(input)) as [
        { message: ChatMessage; turn: AgentTurn },
        { message: ChatMessage; turn: AgentTurn },
      ];
      this.pairedLaunchRepository.attachTurns(
        launchId,
        [queued[0].turn.id, queued[1].turn.id],
        now,
      );
      return queued;
    })();
  }

  createPairedLaunch(
    launchId: string,
    sides: [PairedLaunchSidePlan, PairedLaunchSidePlan],
    now = new Date().toISOString(),
    comparison: PairedLaunchComparisonPlan | null = null,
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.create(
      launchId,
      sides,
      now,
      comparison,
    );
  }

  pairedLaunch(launchId: string): StoredPairedLaunch {
    return this.pairedLaunchRepository.get(launchId);
  }

  findPairedLaunch(launchId: string): StoredPairedLaunch | null {
    return this.pairedLaunchRepository.find(launchId);
  }

  pendingPairedLaunchIds(projectIds: readonly string[], limit: number) {
    return this.pairedLaunchRepository.pendingLaunchIdsForProjects(
      projectIds,
      limit,
    );
  }
  pairedLaunchIdsForDeletionRecovery(scope: { conversationId: string } | { projectId: string }, limit: number) { return this.pairedLaunchRepository.deletionRecoveryLaunchIds(scope, limit); }
  assertConversationDeletionAllowed(conversationId: string): void {
    this.pairedLaunchRepository.assertConversationDeletionAllowed(
      conversationId,
    );
  }

  assertProjectDeletionAllowed(projectId: string): void {
    this.pairedLaunchRepository.assertProjectDeletionAllowed(projectId);
  }

  assertDuoComparisonTurnAllowed(conversationId: string, authorizedLaunchId?: string): void {
    this.pairedLaunchRepository.assertComparisonTurnAllowed(conversationId, authorizedLaunchId);
  }

  pairedLaunchForTurn(turnId: string) { return this.pairedLaunchRepository.launchForTurn(turnId); }

  pairedLaunchComparisonIds(): string[] { return this.pairedLaunchRepository.comparisonLaunchIds(); }
  claimPairedLaunchComparison(
    launchId: string,
    retry: boolean,
    now = new Date().toISOString(),
  ): boolean {
    return this.pairedLaunchRepository.claimComparison(launchId, retry, now);
  }

  attachPairedLaunchComparisonTurn(
    launchId: string,
    turnId: string,
    now = new Date().toISOString(),
  ): void { this.pairedLaunchRepository.attachComparisonTurn(launchId, turnId, now); }

  markPairedLaunchComparisonRunning(
    launchId: string,
    turnId: string,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.markComparisonRunning(launchId, turnId, now);
  }

  settlePairedLaunchComparisonTurn(
    launchId: string,
    turnId: string,
    status: Parameters<PairedLaunchRepository["settleComparisonTurn"]>[2],
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.settleComparisonTurn(
      launchId, turnId, status, now,
    );
  }

  failPairedLaunchComparison(
    launchId: string,
    state: "failed" | "interrupted",
    message: string,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.failComparison(launchId, state, message, now);
  }

  cancelPairedLaunchComparison(
    launchId: string,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.cancelComparison(launchId, now);
  }

  updatePairedLaunchWorktree(
    launchId: string,
    ordinal: 0 | 1,
    path: string | null,
    branch: string | null,
  ): void {
    this.pairedLaunchRepository.updateWorktree(
      launchId,
      ordinal,
      path,
      branch,
    );
  }

  beginPairedLaunchWorktreeCreation(
    launchId: string,
    ordinal: 0 | 1,
    worktreePath: string,
    branch: string,
    ownershipToken: string,
  ): void {
    this.pairedLaunchRepository.beginWorktreeCreation(
      launchId,
      ordinal,
      worktreePath,
      branch,
      ownershipToken,
    );
  }

  rejectPairedLaunchWorktreeCreation(
    launchId: string,
    ordinal: 0 | 1,
  ): void {
    this.pairedLaunchRepository.rejectWorktreeCreation(launchId, ordinal);
  }

  recordPairedLaunchWorktreeCleanupOwnership(
    launchId: string,
    ordinal: 0 | 1,
    plannedWorktreePath: string,
    createdWorktreePath: string,
    branch: string,
    head: string,
    worktreeId: string,
    repositoryIdentity: string,
    ownershipToken: string,
    filesystemReceipt: WorktreeFilesystemReceipt,
  ): void {
    this.pairedLaunchRepository.recordWorktreeCleanupOwnership(
      launchId,
      ordinal,
      plannedWorktreePath,
      createdWorktreePath,
      branch,
      head,
      worktreeId,
      repositoryIdentity,
      ownershipToken,
      filesystemReceipt,
    );
  }

  beginPairedLaunchWorktreeRemoval(
    launchId: string,
    ordinal: 0 | 1,
  ): void {
    this.pairedLaunchRepository.beginWorktreeRemoval(launchId, ordinal);
  }

  confirmPairedLaunchWorktreeRemoval(
    launchId: string,
    ordinal: 0 | 1,
  ): void {
    this.pairedLaunchRepository.confirmWorktreeRemoval(launchId, ordinal);
  }

  recordPairedLaunchBranchCleanupOutcome(
    launchId: string,
    ordinal: 0 | 1,
    outcome: "absent" | "retained",
  ): void {
    this.pairedLaunchRepository.recordBranchCleanupOutcome(
      launchId,
      ordinal,
      outcome,
    );
  }

  recordPairedLaunchWorktreeCleanupObservation(
    launchId: string,
    ordinal: 0 | 1,
    outcome: "absent" | "retained",
    observation: {
      topology: "owned" | "conflict" | null;
      path: string | null;
      branch: string | null;
      head: string | null;
    },
  ): void {
    this.pairedLaunchRepository.recordWorktreeCleanupObservation(
      launchId,
      ordinal,
      outcome,
      observation,
    );
  }

  requestPairedLaunchCancellation(
    launchId: string,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.requestCancel(launchId, now);
  }

  claimPairedLaunchDispatch(
    launchId: string,
    now = new Date().toISOString(),
  ): boolean {
    return this.pairedLaunchRepository.claimDispatch(launchId, now);
  }

  finishPairedLaunchDispatch(
    launchId: string,
    started: readonly [boolean, boolean],
    failure: string | null = null,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.finishDispatch(
      launchId,
      started,
      now,
      failure,
    );
  }

  finishPairedLaunchCancellation(
    launchId: string,
    failure: string | null = null,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.finishCancellation(launchId, now, failure);
  }

  recoverRequestedPairedLaunchCancellations(now = new Date().toISOString()): StoredPairedLaunch[] {
    return this.pairedLaunchRepository.recoverRequestedCancellations(now);
  }

  failPairedLaunch(
    launchId: string,
    state: "failed" | "interrupted" | "recovery-required",
    message: string,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.fail(launchId, state, message, now);
  }

  acknowledgeInterruptedPairedLaunch(
    launchId: string,
    now = new Date().toISOString(),
  ): StoredPairedLaunch {
    return this.pairedLaunchRepository.acknowledgeInterrupted(launchId, now);
  }

  recoverInterruptedPairedLaunches(
    now = new Date().toISOString(),
  ): StoredPairedLaunch[] {
    return this.pairedLaunchRepository.recoverInterrupted(now);
  }

  turnExecutionManifest(turnId: string): SanitizedTurnExecutionManifest | null {
    return this.turnLedgerRepository.executionManifest(turnId);
  }

  agentTurn(turnId: string): AgentTurn {
    return this.turnLedgerRepository.get(turnId);
  }

  agentTurnForRun(runId: string): AgentTurn | null {
    return this.turnLedgerRepository.forRun(runId);
  }

  latestAgentTurnForConversation(conversationId: string): AgentTurn | null {
    return this.turnLedgerRepository.latestForConversation(conversationId);
  }

  assertAgentTurnIdentity(conversationId: string, runId: string, turnId: string): AgentTurn {
    return this.turnLedgerRepository.assertIdentity(conversationId, runId, turnId);
  }

  agentTurnsForConversation(conversationId: string): AgentTurn[] {
    return this.turnLedgerRepository.forConversation(conversationId);
  }

  unfinishedAgentTurns(): AgentTurn[] {
    return this.turnLedgerRepository.unfinished();
  }

  terminalAuthoritativeAgentTurnsMissingGitArtifacts(): AgentTurn[] {
    return this.turnLedgerRepository.terminalAuthoritativeMissingGitArtifacts();
  }

  createTurnGitArtifact(input: CreateTurnGitArtifactInput): StoredTurnGitArtifact {
    return this.gitArtifactRepository.create(input);
  }

  completeTurnGitArtifact(
    turnId: string,
    input: CompleteTurnGitArtifactInput,
  ): StoredTurnGitArtifact {
    return this.gitArtifactRepository.complete(turnId, input);
  }

  turnGitArtifact(turnId: string): TurnGitArtifact | null {
    return this.gitArtifactRepository.get(turnId);
  }

  turnGitArtifactStorage(turnId: string): StoredTurnGitArtifact {
    return this.gitArtifactRepository.storage(turnId);
  }

  pendingTurnGitArtifacts(): StoredTurnGitArtifact[] {
    return this.gitArtifactRepository.pending();
  }

  turnGitArtifactRevision(): string {
    return this.gitArtifactRepository.revision();
  }

  turnGitPatchDigests(): Set<string> {
    return this.gitArtifactRepository.patchDigests();
  }

  expireTurnGitPatch(digest: string): void {
    this.gitArtifactRepository.expirePatch(digest);
  }

  updateAgentTurnLifecycle(turnId: string, update: AgentTurnLifecycleUpdate): AgentTurn {
    return this.turnLedgerRepository.updateLifecycle(turnId, update);
  }

  settleAgentTurn(
    turnId: string,
    update: AgentTurnSettlementUpdate,
  ): AgentTurnSettlementResult {
    return this.turnLedgerRepository.settle(turnId, update);
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
    options?: CreateMessageOptions,
  ): ChatMessage {
    return this.transcriptRepository.createMessage(
      conversationId,
      content,
      role,
      attachments,
      turnId,
      createdAt,
      options,
    );
  }

  createAcknowledgedFollowUpMessage(
    conversationId: string,
    turnId: string,
    content: string,
    createdAt?: string,
    acknowledgedAt?: string, attachments: readonly ChatAttachment[] = [],
  ): ChatMessage {
    return this.transcriptRepository.createAcknowledgedFollowUpMessage(
      conversationId,
      turnId,
      content,
      createdAt,
      acknowledgedAt, attachments,
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

  appendMessageContent(messageId: string, delta: string): void {
    this.transcriptRepository.appendMessageContent(messageId, delta);
  }

  attachments(conversationId?: string): ChatAttachment[] { return this.transcriptRepository.attachments(conversationId); }
  message(messageId: string): ChatMessage {
    return this.transcriptRepository.message(messageId);
  }

  upsertAgentPlan(plan: AgentPlan): void {
    this.executionLedgerRepository.upsertAgentPlan(plan);
  }

  clearAgentPlan(conversationId: string, runId: string, turnId: string | null): void {
    this.executionLedgerRepository.clearAgentPlan(conversationId, runId, turnId);
  }

  agentGoals(conversationId: string): AgentGoal[] {
    return this.agentWorkflowRepository.goals(conversationId);
  }

  upsertAgentGoal(goal: AgentGoal): AgentGoal {
    return this.agentWorkflowRepository.upsert(goal);
  }

  mergeNativeAgentGoal(
    goal: AgentGoal,
    authoritativeMutation = false,
  ): NativeAgentGoalMergeResult {
    return this.agentWorkflowRepository.mergeNative(
      goal,
      authoritativeMutation,
    );
  }

  clearAgentGoal(
    conversationId: string,
    source: AgentGoal["source"],
    tombstoneAt?: string,
    providerSessionId?: string,
  ): boolean {
    return this.agentWorkflowRepository.clear(
      conversationId,
      source,
      tombstoneAt,
      providerSessionId,
    );
  }

  addActivity(
    activity: Omit<AgentActivity, "id" | "createdAt" | "turnId"> & {
      turnId?: string | null;
      createdAt?: string;
    },
  ): AgentActivity {
    return this.executionLedgerRepository.addActivity(activity);
  }

  updateActivity(
    id: string,
    update: Partial<Pick<AgentActivity, "title" | "detail" | "status">>,
  ): AgentActivity {
    return this.executionLedgerRepository.updateActivity(id, update);
  }

  subagentTrace(traceId: string): SubagentTrace {
    return this.executionLedgerRepository.subagentTrace(traceId);
  }

  acknowledgeSubagentStop(
    traceId: string,
    updatedAt = new Date().toISOString(),
  ): UpsertSubagentTraceResult | null {
    return this.executionLedgerRepository.acknowledgeSubagentStop(
      traceId,
      updatedAt,
    );
  }

  upsertSubagentTrace(
    input: UpsertSubagentTraceInput,
  ): UpsertSubagentTraceResult | null {
    return this.executionLedgerRepository.upsertSubagentTrace(input);
  }

  settleLiveSubagents(
    turnId: string,
    status: Extract<SubagentTraceStatus, "cancelled" | "lost">,
    updatedAt = new Date().toISOString(),
  ): SubagentTrace[] {
    return this.executionLedgerRepository.settleLiveSubagents(
      turnId,
      status,
      updatedAt,
    );
  }

  createReasoning(
    conversationId: string,
    runId: string,
    turnId: string | null = null,
  ): AgentReasoning {
    return this.executionLedgerRepository.createReasoning(
      conversationId,
      runId,
      turnId,
    );
  }

  updateReasoning(
    id: string,
    update: Partial<Pick<AgentReasoning, "content" | "status">>,
  ): AgentReasoning {
    return this.executionLedgerRepository.updateReasoning(id, update);
  }

  appendReasoningContent(id: string, delta: string): void {
    this.executionLedgerRepository.appendReasoningContent(id, delta);
  }

  upsertUsage(
    usage: Omit<ThreadUsageSnapshot, "updatedAt" | "turnId"> & {
      turnId?: string | null;
    },
  ): ThreadUsageSnapshot {
    return this.executionLedgerRepository.upsertUsage(usage);
  }

  usageForConversation(conversationId: string): ThreadUsageSnapshot | null {
    return this.executionLedgerRepository.usageForConversation(conversationId);
  }
  usageDashboard(range: UsageDashboardRange) { return this.turnLedgerRepository.usageDashboard(range); }
  dailyWork(range: DailyWorkRange) { return this.turnLedgerRepository.dailyWork(range); }
  checkpointCount(conversationId: string): number {
    return this.executionLedgerRepository.checkpointCount(conversationId);
  }

  addCheckpoint(
    input: Omit<CheckpointSummary, "id" | "createdAt" | "turnId"> & {
      turnId?: string | null;
    },
  ): CheckpointSummary {
    return this.executionLedgerRepository.addCheckpoint(input);
  }

  associateCheckpointWithTurn(
    checkpointId: string,
    conversationId: string,
    runId: string,
    turnId: string,
  ): CheckpointSummary {
    return this.executionLedgerRepository.associateCheckpointWithTurn(
      checkpointId,
      conversationId,
      runId,
      turnId,
    );
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

  reviewNotesFor(
    conversationId: string,
    repositoryPath?: string,
    targetPath?: string,
  ): DiffReviewNote[] {
    return this.reviewRepository.notesFor(
      conversationId,
      repositoryPath,
      targetPath,
    );
  }

  reconcileReviewTargets(
    conversationId: string,
    repositoryPath: string,
    targetPath: string | undefined,
    targets: {
      files: Readonly<Record<string, string>>;
      hunks: Readonly<Record<string, string>>;
      notes: Readonly<Record<string, string | null>>;
    },
  ): boolean {
    return this.reviewRepository.reconcileTargets(
      conversationId,
      repositoryPath,
      targetPath,
      targets,
    );
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

  workspaceRunsForConversation(conversationId: string): WorkspaceRun[] {
    return this.workspaceRunRepository.forConversation(conversationId);
  }

  hasRecordedActiveWorkspaceRunForProject(projectId: string): boolean { return this.workspaceRunRepository.hasActiveForProject(projectId); }
  hasRecordedActiveWorkspaceRunForConversation(conversationId: string): boolean { return this.workspaceRunRepository.hasActiveForConversation(conversationId); }
  hasActiveWorkspaceRunForProject(projectId: string): boolean { return this.conversationWork.hasProject(projectId) || this.hasRecordedActiveWorkspaceRunForProject(projectId); }
  hasActiveWorkspaceRunForConversation(conversationId: string): boolean { return this.conversationWork.hasConversation(conversationId) || this.hasRecordedActiveWorkspaceRunForConversation(conversationId); }

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
    return this.executionLedgerRepository.checkpoint(checkpointId);
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

  private initializeState(): void {
    this.settingsRepository.initialize();
  }

  recoverInterruptedRuns(): void {
    this.recoveryRepository.recoverInterruptedRuns();
  }
}
