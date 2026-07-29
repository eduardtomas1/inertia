import {
  ChevronDown,
  Command,
  Paperclip,
  Send,
  Square,
  Wrench,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentTurn,
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
  Conversation,
  ModelBackendProfileView,
  ProjectAction,
  ProviderInfo,
  ThreadUsageSnapshot,
  UsageDisplayMode,
} from "@shared/contracts";
import { MAX_CHAT_ATTACHMENTS } from "@shared/contracts";
import type {
  ComposerFollowUpState,
  ComposerPrimaryActionState,
} from "../../utils/composerPrimaryAction";
import type { ComposerModelRoute } from "../../utils/modelChooserRoutes";
import type { ModelSearchRoute } from "../../utils/modelSearch";
import {
  contextUsageQualityForTurn,
  usageQuotaSourceForSelection,
} from "../../utils/usageDisplay";
import { ModelChooser } from "../ModelChooser";
import { IconButton, LoadingMark } from "../ui";
import { UsageIndicator } from "../UsageIndicator";
import { menuId } from "./config";
import { ComposerMoreMenu } from "./ComposerMoreMenu";
import {
  ComposerSettings,
  type ComposerSettingsModel,
} from "./ComposerSettings";
import type { ComposerMenuController } from "./useComposerMenus";
import type { PromptStashEntry } from "../../utils/promptStash";
import { PromptStashMenu } from "./PromptStashMenu";
import { ComposerSkillsMenu } from "./ComposerSkillsMenu";

export interface ComposerToolbarProps {
  actions: ProjectAction[];
  disabled: boolean;
  running: boolean;
  attachmentCount: number;
  onChooseAttachments: () => Promise<void>;
  onRunAction: (action: ProjectAction) => void;
  skills: readonly AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability | null;
  selectedSkillIds: readonly string[];
  skillsLoading: boolean;
  skillsError: string | null;
  onListSkills: (forceReload?: boolean) => Promise<void>;
  onToggleSkill: (skill: AgentSkillSummary) => void;
  onClearSelectedSkills: () => void;
  promptStash: readonly PromptStashEntry[];
  canStashPrompt: boolean;
  promptStashBlockedReason: string | null;
  promptRestoreBlockedReason: (entry: PromptStashEntry) => string | null;
  onStashPrompt: () => void;
  onRestorePrompt: (entry: PromptStashEntry) => void;
  onRemoveStashedPrompt: (entryId: string) => void;
  modelRoutes: ComposerModelRoute[];
  selectedModelRoute: ModelSearchRoute;
  onChooseModelRoute: (route: ComposerModelRoute) => void;
  selectedModel: ComposerSettingsModel | undefined;
  selectedReasoning: string;
  reasoningLabel: string;
  onUpdateReasoningEffort: (reasoningEffort: string) => void;
  conversation: Conversation;
  onUpdateConversation: (
    update: Partial<Pick<
      Conversation,
      "reasoningEffort" | "interactionMode" | "accessMode" | "modelSelection"
    >>,
  ) => void;
  menuController: ComposerMenuController;
  selectedProvider: ProviderInfo | undefined;
  selectedBackendProfile: ModelBackendProfileView | undefined;
  selectedIdentityLabel: string;
  usage: ThreadUsageSnapshot | null;
  usageDisplayMode: UsageDisplayMode;
  latestTurn: AgentTurn | null;
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  followUpState: ComposerFollowUpState;
  primaryAction: ComposerPrimaryActionState;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
}

export function ComposerToolbar({
  actions,
  disabled,
  running,
  attachmentCount,
  onChooseAttachments,
  onRunAction,
  skills,
  skillsCapability,
  selectedSkillIds,
  skillsLoading,
  skillsError,
  onListSkills,
  onToggleSkill,
  onClearSelectedSkills,
  promptStash,
  canStashPrompt,
  promptStashBlockedReason,
  promptRestoreBlockedReason,
  onStashPrompt,
  onRestorePrompt,
  onRemoveStashedPrompt,
  modelRoutes,
  selectedModelRoute,
  onChooseModelRoute,
  selectedModel,
  selectedReasoning,
  reasoningLabel,
  onUpdateReasoningEffort,
  conversation,
  onUpdateConversation,
  menuController,
  selectedProvider,
  selectedBackendProfile,
  selectedIdentityLabel,
  usage,
  usageDisplayMode,
  latestTurn,
  onUsageDisplayModeChange,
  followUpState,
  primaryAction,
  onSubmit,
  onStop,
}: ComposerToolbarProps): React.JSX.Element {
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = menuController;
  return (
    <div className="composer-toolbar" data-composer-zone="controls">
      <div className="composer-tools">
        <IconButton
          label="Attach images or documents"
          onClick={() => void onChooseAttachments()}
          disabled={
            disabled
            || primaryAction === "submitting"
            || running
            || attachmentCount >= MAX_CHAT_ATTACHMENTS
          }
        >
          <Paperclip size={16} />
        </IconButton>
        <PromptStashMenu
          entries={promptStash}
          canStash={canStashPrompt}
          blockedReason={promptStashBlockedReason}
          restoreBlockedReason={promptRestoreBlockedReason}
          menuController={menuController}
          onStash={onStashPrompt}
          onRestore={onRestorePrompt}
          onRemove={onRemoveStashedPrompt}
        />
        <ComposerSkillsMenu
          skills={skills}
          capability={skillsCapability}
          selectedSkillIds={selectedSkillIds}
          loading={skillsLoading}
          error={skillsError}
          disabled={disabled}
          running={running}
          menuController={menuController}
          onList={onListSkills}
          onToggle={onToggleSkill}
          onClear={onClearSelectedSkills}
        />
        {actions.length > 0 && (
          <div className="popover-anchor composer-action-control">
            <button
              ref={(node) => setMenuTrigger("action", node)}
              type="button"
              className={clsx(
                "composer-pill",
                menu === "action" && "is-active",
              )}
              aria-label="Open project actions"
              aria-haspopup="menu"
              aria-controls={menuId("action")}
              aria-expanded={menu === "action"}
              onClick={() => toggleMenu("action")}
            >
              <Wrench size={14} />
              <span>Actions</span>
              <ChevronDown size={12} />
            </button>
            {menu === "action" && (
              <div
                ref={(node) => setMenuPopover("action", node)}
                id={menuId("action")}
                className="composer-popover action-popover"
                role="menu"
                aria-label="Project actions"
              >
                <div className="popover-title">Package scripts</div>
                {actions.map((action) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={action.id}
                    onClick={() => {
                      dismissMenu("selection");
                      onRunAction(action);
                    }}
                  >
                    <Command size={15} />
                    <span>
                      <strong>{action.label}</strong>
                      <small>{action.command}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="composer-options">
        <ModelChooser
          routes={modelRoutes}
          selectedRoute={selectedModelRoute}
          disabled={disabled || running}
          closeSignal={menu}
          onOpenChange={(open) => {
            if (open) dismissMenu("context-change");
          }}
          onSelect={onChooseModelRoute}
        />
        <ComposerSettings
          selectedModel={selectedModel}
          selectedReasoning={selectedReasoning}
          reasoningLabel={reasoningLabel}
          conversation={conversation}
          disabled={disabled}
          running={running}
          menuController={menuController}
          onUpdateReasoningEffort={onUpdateReasoningEffort}
          onUpdateConversation={onUpdateConversation}
        />
        <ComposerMoreMenu
          actions={actions}
          selectedModel={selectedModel}
          selectedReasoning={selectedReasoning}
          reasoningLabel={reasoningLabel}
          conversation={conversation}
          disabled={disabled}
          running={running}
          menuController={menuController}
          onRunAction={onRunAction}
          onUpdateReasoningEffort={onUpdateReasoningEffort}
          onUpdateConversation={onUpdateConversation}
        />
        {selectedProvider && (
          <UsageIndicator
            usage={usage}
            rateLimits={selectedProvider.rateLimits}
            rateLimitState={selectedProvider.metadataState.rateLimits}
            quotaSource={usageQuotaSourceForSelection(
              conversation.modelSelection,
              selectedBackendProfile,
            )}
            mode={usageDisplayMode}
            providerLabel={selectedIdentityLabel}
            contextQuality={contextUsageQualityForTurn(
              usage,
              latestTurn?.id ?? null,
            )}
            onModeChange={onUsageDisplayModeChange}
          />
        )}
        {followUpState === "ready" || followUpState === "pending" ? (
          <button
            type="button"
            className="secondary-button composer-follow-up-button"
            aria-label={followUpState === "pending"
              ? "Sending follow-up"
              : "Send follow-up"}
            aria-busy={followUpState === "pending"}
            disabled={followUpState === "pending"}
            onClick={() => void onSubmit()}
          >
            {followUpState === "pending"
              ? <LoadingMark label="Sending follow-up" />
              : <Send size={13} />}
            <span>
              {followUpState === "pending" ? "Sending…" : "Follow up"}
            </span>
          </button>
        ) : followUpState === "unavailable" ? (
          <small
            className="composer-follow-up-unavailable"
            role="status"
            title="This active agent route cannot accept parent follow-ups."
          >
            Follow-up unavailable
          </small>
        ) : null}
        {primaryAction === "stop-ready" || primaryAction === "stop-pending" ? (
          <IconButton
            label={primaryAction === "stop-pending"
              ? "Stopping agent"
              : "Stop agent"}
            className="send-button stop-button"
            data-composer-action-state={primaryAction}
            aria-busy={primaryAction === "stop-pending"}
            onClick={() => void onStop()}
            disabled={primaryAction === "stop-pending"}
          >
            <Square size={13} fill="currentColor" />
          </IconButton>
        ) : primaryAction === "submitting" ? (
          <IconButton
            label="Sending message"
            className="send-button send-button-loading"
            data-composer-action-state={primaryAction}
            aria-busy="true"
            disabled
          >
            <LoadingMark label="Sending message" />
          </IconButton>
        ) : (
          <IconButton
            label="Send message"
            className="send-button"
            data-composer-action-state={primaryAction}
            onClick={() => void onSubmit()}
            disabled={primaryAction === "send-disabled"}
          >
            <Send size={16} />
          </IconButton>
        )}
      </div>
    </div>
  );
}
