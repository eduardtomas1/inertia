import type {
  ModelBackendDefault,
  ModelBackendProfileView,
} from "../backend-profile-settings";
import type {
  ContinuationIdentity,
  ModelSelection,
} from "../model-routing";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceStatus,
} from "../provider-maintenance";
import type { ProviderId } from "../provider";
import type { ProviderIdentityLabels } from "../provider-identities";
import {
  DEFAULT_APP_KEYBINDINGS,
  type AppKeybindings,
} from "../keybindings";
import type { AgentTurnStatus } from "../turn-lifecycle";
import type { PromptPreset } from "../prompt-presets";

export type { ProviderId } from "../provider";

export type ThemePreference = "system" | "light" | "dark";
export type ProjectStatus = "ready" | "working" | "attention";
export type MessageRole = "user" | "assistant" | "system";
export type ProviderInstallState = "checking" | "installed" | "not-installed" | "error";
export type ProviderAuthState = "checking" | "authenticated" | "unauthenticated" | "configured" | "unknown" | "error";
export type InteractionMode = "build" | "plan";
export type AccessMode = "supervised" | "auto-edit" | "full";
export type ThreadStatus = "idle" | "running" | "needs-input" | "completed" | "failed";
export type AgentApprovalDecision = "approve" | "deny" | "cancel";
export type ResponseDensity = "compact" | "default" | "comfortable";
export type WorkspaceStartupSurface = "summary" | "tools";
export type InterfaceScale = "compact" | "default" | "comfortable" | "large";
export type UsageDisplayMode = "expanded" | "compact" | "hidden";
export type SidebarMode = "classic" | "activity";
export type ProjectGroupingMode = "repository" | "repository-path" | "separate";
export type ThreadAttentionKind = "approval" | "input";
export type AttentionState = "unseen" | "seen" | "acknowledged" | "dismissed";

export interface ConversationLatestTurnSummary {
  id: string;
  runId: string;
  status: AgentTurnStatus;
  providerId: ProviderId;
  harnessId: ContinuationIdentity["harnessId"];
  backendProfileId: ModelSelection["backendProfileId"];
  modelSelection: ModelSelection;
  continuationIdentity: ContinuationIdentity;
  model: string;
  reasoningEffort: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  terminalReason: string | null;
  updatedAt: string;
}

export interface ProviderReasoningOption {
  value: string;
  label: string;
  description: string;
}

export interface ProviderFastMode {
  /** Exact provider-native value persisted in ModelSelection.providerOptions. */
  providerValue: string;
  label: string;
  description: string;
  isDefault: boolean;
}

export interface ProviderModel {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  inputModalities: Array<"text" | "image">;
  reasoningOptions: ProviderReasoningOption[];
  defaultReasoningEffort: string;
  /** Missing is accepted only for metadata cached before Fast mode shipped. */
  fastMode?: ProviderFastMode | null;
}

export interface ProviderRateLimit {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}

export type ProviderMetadataFreshness = "unavailable" | "fresh" | "stale";
export type ProviderMetadataProvenance = "provider" | "session" | "persistent-cache";

export interface ProviderMetadataFieldState {
  freshness: ProviderMetadataFreshness;
  provenance: ProviderMetadataProvenance | null;
  updatedAt: string | null;
  lastAttemptedAt: string | null;
  refreshing: boolean;
}

export interface ProviderMetadataState {
  models: ProviderMetadataFieldState;
  rateLimits: ProviderMetadataFieldState;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  command: string;
  available: boolean;
  version: string | null;
  /** Resolved provider executable selected after discovery. */
  executable?: string | null;
  installState: ProviderInstallState;
  authState: ProviderAuthState;
  canRun: boolean;
  statusMessage: string | null;
  models: ProviderModel[];
  rateLimits: ProviderRateLimit[];
  metadataState: ProviderMetadataState;
  /** Present after the runtime has checked this exact installed CLI. */
  maintenance?: ProviderMaintenanceStatus;
}

export interface AppSettings {
  theme: ThemePreference;
  compactSidebar: boolean;
  showTimestamps: boolean;
  terminalFontSize: number;
  defaultProvider: ProviderId;
  defaultModel: string;
  defaultAccessMode: AccessMode;
  newThreadMode: "local" | "worktree";
  wrapDiffs: boolean;
  ignoreWhitespace: boolean;
  showThinking: boolean;
  usageDisplayMode: UsageDisplayMode;
  interfaceScale: InterfaceScale;
  responseDensity: ResponseDensity;
  workspaceStartupSurface: WorkspaceStartupSurface;
  defaultCodeWrap: boolean;
  autoCollapseWorkLog: boolean;
  showChangedFileSummaries: boolean;
  autoScrollToFinalAnswer: boolean;
  sidebarMode: SidebarMode;
  projectGrouping: ProjectGroupingMode;
  autoOpenPlan: boolean;
  confirmDestructiveActions: boolean;
  desktopNotifications: boolean;
  /** Local display aliases only; provider authentication remains provider-owned. */
  providerIdentityLabels: ProviderIdentityLabels;
  /** App-local Cmd/Ctrl chords; the primary modifier is never remapped. */
  keybindings: AppKeybindings;
  defaultReasoningEffort: string;
  defaultInteractionMode: InteractionMode;
  /** Empty uses automatic discovery; otherwise an explicitly validated Codex binary or shim. */
  codexBinaryPath: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  normalizedPath: string;
  repositoryIdentity: string | null;
  repositoryRoot: string | null;
  repositoryRelativePath: string;
  groupingMode: ProjectGroupingMode | null;
  /** Maximum nested Git roots shown for this project during workspace discovery. */
  gitRepositoryLimit: number;
  color: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  providerId: ProviderId;
  /** Canonical harness/backend/model configuration for the next turn. */
  modelSelection: ModelSelection;
  continuationIdentity: ContinuationIdentity | null;
  /** @deprecated Read-only compatibility projection of modelSelection.modelId. */
  model: string;
  reasoningEffort: string;
  interactionMode: InteractionMode;
  accessMode: AccessMode;
  status: ThreadStatus;
  attentionKind: ThreadAttentionKind | null;
  branch: string | null;
  worktreePath: string | null;
  providerSessionId: string | null;
  archivedAt: string | null;
  settledAt: string | null;
  completedAt: string | null;
  lastViewedAt: string | null;
  /** Optional only for snapshots created before thread organization shipped. */
  pinnedAt?: string | null;
  /** Optional only for snapshots created before thread organization shipped. */
  snoozedUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lightweight navigation metadata. Shells are safe to keep for every
 * conversation because they never contain transcript, reasoning, plan, or
 * artifact payloads.
 */
export type ConversationShell = Conversation & {
  latestTurn: ConversationLatestTurnSummary | null;
  pendingApproval: boolean;
  pendingInput: boolean;
};

export interface WorkspaceRun {
  id: string;
  kind: "agent" | "check" | "service" | "source-control";
  projectId: string;
  conversationId: string | null;
  /** Stable package-script identity for safely validated retry/rerun actions. */
  actionId: string | null;
  label: string;
  detail: string | null;
  status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
  /** Durable user disposition; independent from the run lifecycle and thread settlement. */
  attentionState: AttentionState;
  /** Ephemeral runtime capability. False after a restart or when no owned process exists. */
  canStop: boolean;
  port: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RuntimeSyncCursor {
  runtimeGeneration: string;
  latestSequence: number;
}

export interface AppSnapshot {
  projects: Project[];
  conversations: ConversationShell[];
  runs: WorkspaceRun[];
  providers: ProviderInfo[];
  /**
   * Bounded active provider updates used to restore progress and cancellation
   * after a full renderer synchronization. Historical operations remain
   * event-driven and are intentionally excluded.
   */
  maintenanceOperations?: ProviderMaintenanceOperation[];
  /** Safe backend configuration only; credential values and references are forbidden. */
  backendProfiles?: ModelBackendProfileView[];
  backendDefaults?: ModelBackendDefault[];
  /** Automatic full-database backup status; absent from legacy fixtures. */
  databaseBackup?: DatabaseBackupStatus;
  settings: AppSettings;
  /** Present on authoritative snapshots; optional only for legacy fixtures. */
  promptPresets?: PromptPreset[];
  activeProjectId: string | null;
  activeConversationId: string | null;
  /** Present on authoritative runtime snapshots; optional for legacy fixtures. */
  sync?: RuntimeSyncCursor;
}

export interface DatabaseBackupStatus {
  lastValidatedAt: string | null;
}

export const defaultSettings: AppSettings = {
  theme: "system",
  compactSidebar: false,
  showTimestamps: true,
  terminalFontSize: 13,
  defaultProvider: "codex",
  defaultModel: "",
  defaultAccessMode: "supervised",
  newThreadMode: "local",
  wrapDiffs: true,
  ignoreWhitespace: false,
  showThinking: true,
  usageDisplayMode: "compact",
  interfaceScale: "default",
  responseDensity: "default",
  workspaceStartupSurface: "summary",
  defaultCodeWrap: false,
  autoCollapseWorkLog: true,
  showChangedFileSummaries: true,
  autoScrollToFinalAnswer: true,
  sidebarMode: "classic",
  projectGrouping: "separate",
  autoOpenPlan: false,
  confirmDestructiveActions: true,
  desktopNotifications: true,
  providerIdentityLabels: {},
  keybindings: DEFAULT_APP_KEYBINDINGS,
  defaultReasoningEffort: "",
  defaultInteractionMode: "build",
  codexBinaryPath: "",
};
