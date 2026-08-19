import type {
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
  AgentTurn,
  ChatAttachment,
  Conversation,
  ConversationContextPacketSummary,
  ConversationLatestTurnSummary,
  ModelBackendProfileView,
  ModelSelection,
  ProjectAction,
  ProviderId,
  ProviderInfo,
  PromptPreset,
  ThreadUsageSnapshot,
  TurnRequestContext,
  UsageDisplayMode,
  WorkspaceEntry,
} from "@shared/contracts";
import type { ProviderIdentityLabels } from "@shared/provider-identities";
import type { AttachmentPickerMode } from "@shared/desktop";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import type { ChatGoalControlProps } from "../ChatGoalControl";
import type { ProviderTerminalResumeOption } from "../providerResumeOptions";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "../conversation-context/types";

export interface ComposerProps {
  conversation: Conversation;
  checkoutBranch?: string | null;
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
  skillsLoading: boolean;
  skillsError: string | null;
  promptContext?: string | null;
  contextSources?: readonly ConversationContextSourceOption[];
  contextPackets?: readonly ConversationContextPacketSummary[];
  onConversationContextCommand?: ConversationContextCommandRunner;
  previewContextUrl?: string | null;
  providerIdentityLabels?: ProviderIdentityLabels;
  goal?: ChatGoalControlProps | null;
  onSend: (
    message: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => Promise<void>;
  onCompact?: (instruction?: string) => Promise<{
    message: string;
    instructionForwarded: boolean;
  }>;
  onListSkills: (forceReload?: boolean) => Promise<void>;
  promptPresets?: readonly PromptPreset[];
  onPromptPresetCommand?: PromptPresetCommandRunner;
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
  onChooseAttachments: (
    mode?: AttachmentPickerMode,
  ) => Promise<ChatAttachment[]>;
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
  resumeOptions?: readonly ProviderTerminalResumeOption[];
  onResumeConversation?: (conversationId: string) => void;
  onStop: () => Promise<void>;
  onClearPromptContext?: () => void;
}

export type PromptPresetCommand = Extract<
  CommandWithoutId,
  { type: `prompt-preset.${string}` }
>;
export type PromptPresetCommandRunner = (
  key: PromptPresetCommand["type"],
  command: PromptPresetCommand,
) => Promise<unknown>;

export type ComposerMenu =
  | "reasoning"
  | "speed"
  | "mode"
  | "access"
  | "action"
  | "skills"
  | "presets"
  | "stash"
  | "more";
export type MoreSection = "actions" | "reasoning" | "speed" | "mode" | "access";

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
