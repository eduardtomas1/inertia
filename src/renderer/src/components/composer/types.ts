import type {
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
  AgentTurn,
  ChatAttachment,
  Conversation,
  ConversationLatestTurnSummary,
  ModelBackendProfileView,
  ModelSelection,
  ProjectAction,
  ProviderId,
  ProviderInfo,
  ThreadUsageSnapshot,
  TurnRequestContext,
  UsageDisplayMode,
  WorkspaceEntry,
} from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type { ChatGoalControlProps } from "../ChatGoalControl";

export interface ComposerProps {
  conversation: Conversation;
  providers: ProviderInfo[];
  actions: ProjectAction[];
  disabled: boolean;
  sending: boolean;
  running: boolean;
  backendProfiles?: ModelBackendProfileView[];
  latestTurn?: AgentTurn | null;
  latestTurnSummary?: ConversationLatestTurnSummary | null;
  mentionResults: WorkspaceEntry[];
  usage: ThreadUsageSnapshot | null;
  usageDisplayMode: UsageDisplayMode;
  skills: AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability | null;
  selectedSkillIds: readonly string[];
  skillsLoading: boolean;
  skillsError: string | null;
  promptContext?: string | null;
  previewContextUrl?: string | null;
  providerIdentityLabels?: ProviderIdentityLabels;
  goal?: ChatGoalControlProps | null;
  onSend: (
    message: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
  ) => Promise<void>;
  onListSkills: (forceReload?: boolean) => Promise<void>;
  onToggleSkill: (skill: AgentSkillSummary) => void;
  onClearSelectedSkills: () => void;
  onUpdateConversation: (
    update: Partial<Pick<
      Conversation,
      | "providerId"
      | "modelSelection"
      | "model"
      | "reasoningEffort"
      | "interactionMode"
      | "accessMode"
    >>,
  ) => Promise<void>;
  onCreateConversationForSelection?: (
    selection: ModelSelection,
    options?: { prefillText?: string },
  ) => Promise<void>;
  onChooseAttachments: () => Promise<ChatAttachment[]>;
  onImportAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onReleaseAttachment: (id: string) => Promise<void>;
  onRunAction: (action: ProjectAction) => void;
  onMentionQuery: (query: string) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
  onProbeBackendProfile: (profileId: string, modelId: string) => Promise<void>;
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  onOpenResume: () => void;
  onStop: () => Promise<void>;
  onClearPromptContext?: () => void;
}

export type ComposerMenu =
  | "reasoning"
  | "mode"
  | "access"
  | "action"
  | "skills"
  | "stash"
  | "more";
export type MoreSection = "actions" | "reasoning" | "mode" | "access";

export interface PendingModelRoute {
  selection: ModelSelection;
  label: string;
  reason: string;
  sourceConversationId: string;
  sourceProjectId: string;
  sourceSelectionKey: string;
  sourceContinuationKey: string;
  sourceLatestTurnId: string | null;
  sourceLatestTurnKey: string;
  destinationRevision: number;
}
