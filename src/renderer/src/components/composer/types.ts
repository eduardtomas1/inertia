import type {
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
  AgentTurn,
  ChatAttachment,
  Conversation,
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

export interface ComposerProps {
  conversation: Conversation;
  providers: ProviderInfo[];
  actions: ProjectAction[];
  disabled: boolean;
  sending: boolean;
  running: boolean;
  backendProfiles?: ModelBackendProfileView[];
  latestTurn?: AgentTurn | null;
  mentionResults: WorkspaceEntry[];
  usage: ThreadUsageSnapshot | null;
  usageDisplayMode: UsageDisplayMode;
  skills: AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability | null;
  selectedSkillIds: readonly string[];
  skillsLoading: boolean;
  skillsError: string | null;
  promptContext?: string | null;
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
  onCreateConversationForSelection?: (selection: ModelSelection) => Promise<void>;
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
}
