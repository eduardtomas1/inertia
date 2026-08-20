import { lazy, Suspense } from "react";
import {
  ChevronDown,
  Command,
  FolderGit2,
  GitBranch,
  MessagesSquare,
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
  PromptPreset,
  ThreadUsageSnapshot,
  UsageDisplayMode,
} from "@shared/contracts";
import { MAX_CHAT_ATTACHMENTS } from "@shared/attachments";
import {
  modelSelectionUsesFastMode,
  routeSupportsNativeFastModeIdentity,
} from "../../../../shared/model-routing";
import {
  supportsActiveParentFollowUp,
  type ComposerFollowUpState,
  type ComposerPrimaryActionState,
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
import {
  ComposerSettings,
  type ComposerSettingsModel,
} from "./ComposerSettings";
import type { ComposerMenuController } from "./useComposerMenus";
import type { PromptPresetCommandRunner } from "./types";
import type { PromptStashEntry } from "../../utils/promptStash";

const PromptStashMenu = lazy(async () => ({
  default: (await import("./PromptStashMenu")).PromptStashMenu,
}));
const PromptPresetMenu = lazy(async () => ({
  default: (await import("./PromptPresetMenu")).PromptPresetMenu,
}));
const ComposerSkillsMenu = lazy(async () => ({
  default: (await import("./ComposerSkillsMenu")).ComposerSkillsMenu,
}));
const ComposerMoreMenu = lazy(async () => ({
  default: (await import("./ComposerMoreMenu")).ComposerMoreMenu,
}));

export function composerCheckoutBranch(
  conversation: Pick<Conversation, "branch" | "worktreePath">,
  checkoutBranch: string | null | undefined,
): string {
  return (conversation.worktreePath
    ? conversation.branch ?? checkoutBranch
    : checkoutBranch ?? conversation.branch) ?? "Detached HEAD";
}

export interface ComposerToolbarProps {
  actions: ProjectAction[];
  disabled: boolean;
  running: boolean;
  attachmentCount: number;
  onChooseAttachments: () => Promise<void>;
  onRunAction: (action: ProjectAction) => void;
  skills: readonly AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability | null;
  skillsLoading: boolean;
  skillsError: string | null;
  onListSkills: (forceReload?: boolean) => Promise<void>;
  onInsertSkill: (skill: AgentSkillSummary) => void;
  promptPresets: readonly PromptPreset[];
  currentPrompt: string;
  onApplyPromptPreset: (preset: PromptPreset) => Promise<boolean>;
  onPromptPresetCommand: PromptPresetCommandRunner;
  promptStash: readonly PromptStashEntry[];
  canStashPrompt: boolean;
  promptStashBlockedReason: string | null;
  promptRestoreBlockedReason: (entry: PromptStashEntry) => string | null;
  onStashPrompt: () => void;
  onRestorePrompt: (entry: PromptStashEntry) => void;
  onRemoveStashedPrompt: (entryId: string) => void;
  onSetPromptRecurrence: (
    entryId: string,
    recurrence: PromptStashEntry["recurrence"],
  ) => void;
  modelRoutes: ComposerModelRoute[];
  selectedModelRoute: ModelSearchRoute;
  onChooseModelRoute: (route: ComposerModelRoute) => Promise<void>;
  selectedModel: ComposerSettingsModel | undefined;
  selectedReasoning: string;
  reasoningLabel: string;
  selectedFastMode: boolean;
  onUpdateReasoningEffort: (reasoningEffort: string) => Promise<void>;
  onUpdateFastMode: (enabled: boolean) => Promise<void>;
  conversation: Conversation;
  checkoutBranch?: string | null;
  onUpdateConversation: (
    update: Partial<Pick<
      Conversation,
      "reasoningEffort" | "interactionMode" | "accessMode" | "modelSelection"
    >>,
  ) => Promise<void>;
  conversationUpdatePending: boolean;
  conversationUpdateError: string | null;
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
  skillsLoading,
  skillsError,
  onListSkills,
  onInsertSkill,
  promptPresets,
  currentPrompt,
  onApplyPromptPreset,
  onPromptPresetCommand,
  promptStash,
  canStashPrompt,
  promptStashBlockedReason,
  promptRestoreBlockedReason,
  onStashPrompt,
  onRestorePrompt,
  onRemoveStashedPrompt,
  onSetPromptRecurrence,
  modelRoutes,
  selectedModelRoute,
  onChooseModelRoute,
  selectedModel,
  selectedReasoning,
  reasoningLabel,
  selectedFastMode,
  onUpdateReasoningEffort,
  onUpdateFastMode,
  conversation,
  checkoutBranch,
  onUpdateConversation,
  conversationUpdatePending,
  conversationUpdateError,
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
  const canAttachWhileRunning = supportsActiveParentFollowUp(
    latestTurn?.harnessId ?? null,
  );
  const visibleCheckoutBranch = composerCheckoutBranch(
    conversation,
    checkoutBranch,
  );
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = menuController;
  return (
    <div
      className="composer-toolbar"
      role="group"
      aria-label="Composer controls"
    >
      <div className="composer-primary-rail">
        <div
          className="composer-options"
          role="group"
          aria-label="Model and run settings"
        >
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
          {conversationUpdateError ? (
            <p
              className="composer-control-error composer-route-control-error"
              role="alert"
              aria-live="assertive"
            >
              {conversationUpdateError}
            </p>
          ) : null}
          <ComposerSettings
            selectedModel={selectedModel}
            selectedReasoning={selectedReasoning}
            reasoningLabel={reasoningLabel}
            selectedFastMode={selectedFastMode}
            conversation={conversation}
            disabled={disabled}
            running={running}
            menuController={menuController}
            onUpdateReasoningEffort={onUpdateReasoningEffort}
            onUpdateFastMode={onUpdateFastMode}
            onUpdateConversation={onUpdateConversation}
            conversationUpdatePending={conversationUpdatePending}
          />
          <Suspense fallback={null}>
            <ComposerMoreMenu
              actions={actions}
              selectedModel={selectedModel}
              selectedReasoning={selectedReasoning}
              reasoningLabel={reasoningLabel}
              selectedFastMode={selectedFastMode}
              conversation={conversation}
              disabled={disabled}
              running={running}
              menuController={menuController}
              onRunAction={onRunAction}
              onUpdateReasoningEffort={onUpdateReasoningEffort}
              onUpdateFastMode={onUpdateFastMode}
              onUpdateConversation={onUpdateConversation}
              conversationUpdatePending={conversationUpdatePending}
            />
          </Suspense>
          {selectedProvider?.agentThreadManagement && (
            <span
              className={clsx(
                "composer-pill composer-action-control",
                selectedProvider.agentThreadManagement.state === "supported"
                  ? "is-active"
                  : undefined,
              )}
              aria-label={`Agent chat tools: ${selectedProvider.agentThreadManagement.state}`}
              title={selectedProvider.agentThreadManagement.detail}
            >
              <MessagesSquare size={13} aria-hidden="true" />
              <span>Chat tools</span>
            </span>
          )}
        </div>
        <div
          className="composer-tools"
          role="group"
          aria-label="Add context"
        >
        <IconButton
          label={running ? "Attach follow-up images" : "Attach images or documents"}
          onClick={() => void onChooseAttachments()}
          disabled={
            disabled
            || primaryAction === "submitting"
            || (running && !canAttachWhileRunning)
            || attachmentCount >= MAX_CHAT_ATTACHMENTS
          }
        >
          <Paperclip size={16} />
        </IconButton>
        <Suspense fallback={null}>
          <PromptPresetMenu
            presets={promptPresets}
            currentMessage={currentPrompt}
            currentRoute={{
              harnessId: conversation.modelSelection.harnessId,
              backendProfileId: conversation.modelSelection.backendProfileId,
              modelId: conversation.modelSelection.modelId,
              reasoningEffort: conversation.modelSelection.reasoningEffort,
              ...((selectedModel?.fastMode || selectedFastMode)
                && routeSupportsNativeFastModeIdentity(
                  conversation.modelSelection,
                )
                ? {
                    fastMode: modelSelectionUsesFastMode(
                      conversation.modelSelection,
                    ),
                  }
                : {}),
            }}
            menuController={menuController}
            onApply={onApplyPromptPreset}
            onCommand={onPromptPresetCommand}
          />
        </Suspense>
        <Suspense fallback={null}>
          <PromptStashMenu
            entries={promptStash}
            canStash={canStashPrompt}
            blockedReason={promptStashBlockedReason}
            restoreBlockedReason={promptRestoreBlockedReason}
            menuController={menuController}
            onStash={onStashPrompt}
            onRestore={onRestorePrompt}
            onRemove={onRemoveStashedPrompt}
            onSetRecurrence={onSetPromptRecurrence}
          />
        </Suspense>
        <Suspense fallback={null}>
          <ComposerSkillsMenu
            skills={skills}
            capability={skillsCapability}
            loading={skillsLoading}
            error={skillsError}
            disabled={disabled}
            running={running}
            menuController={menuController}
            onList={onListSkills}
            onInsert={onInsertSkill}
          />
        </Suspense>
        {actions.length > 0 ? (
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
        ) : null}
        </div>
        <div
          className="composer-actions"
          role="group"
          aria-label="Usage and message actions"
        >
        {selectedProvider ? (
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
        ) : null}
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
      <div
        className="composer-checkout-strip"
        role="group"
        aria-label="Chat checkout context"
      >
        <span className="composer-checkout-location">
          <FolderGit2 size={12} aria-hidden="true" />
          <span>{conversation.worktreePath ? "Isolated worktree" : "Current checkout"}</span>
        </span>
        <span
          className="composer-checkout-branch"
          title={visibleCheckoutBranch}
        >
          <GitBranch size={12} aria-hidden="true" />
          <code translate="no">{visibleCheckoutBranch}</code>
        </span>
      </div>
    </div>
  );
}
