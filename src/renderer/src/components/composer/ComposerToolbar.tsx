import { lazy, Suspense, useContext, useEffect, useId, useRef } from "react";
import {
  ChevronDown,
  Ellipsis,
  Paperclip,
  Play,
  Wrench,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentTurn,
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
  ChatAttachment,
  Conversation,
  ModelBackendProfileView,
  ProjectAction,
  ProviderInfo,
  PromptPreset,
  ThreadUsageSnapshot,
  UsageDisplayMode,
} from "@shared/contracts";
import { MAX_ATTACHMENT_COUNT } from "@shared/attachments";
import {
  modelSelectionUsesFastMode,
  routeSupportsNativeFastModeIdentity,
} from "../../../../shared/model-routing";
import {
  supportsActiveParentFollowUp,
  type ComposerPrimaryActionState,
} from "../../utils/composerPrimaryAction";
import type { ComposerModelRoute } from "../../utils/modelChooserRoutes";
import type { ModelSearchRoute } from "../../utils/modelSearch";
import {
  contextUsageQualityForTurn,
  usageQuotaSourceForSelection,
} from "../../utils/usageDisplay";
import { CheckoutBranchControlContext, CheckoutBranchSlot } from "../CheckoutBranchControl";
import { checkoutBranchChip, type CheckoutBranchMenuOpener } from "../checkoutBranchChip";
import { conversationContextMismatch } from "../../lib/newConversation";
import { setComposerToolsOpen, useComposerToolsOpen } from "../../hooks/useComposerToolsOpen";
import { ModelChooser } from "../ModelChooser";
import { IconButton, LoadingMark } from "../ui";
import { UsageIndicator } from "../UsageIndicator";
import { menuId } from "./config";
import {
  ComposerSettings,
  type ComposerSettingsModel,
} from "./ComposerSettings";
import { ComposerSendActionsFallback } from "./ComposerSendActionsFallback";
import { ProjectPicker } from "./ProjectPicker";
import type { ComposerMenuController } from "./useComposerMenus";
import { useComposerChipFolding, type ComposerFoldKey } from "./useComposerChipFolding";
import type { NewChatProjectPicker, PromptPresetCommandRunner } from "./types";
import type { AgentTurnStatus } from "../../../../shared/turn-lifecycle";
import type { PromptStashEntry } from "../../utils/promptStash";
import type { QueueCommandRunner } from "./runtimeQueueClient";
import type { ComposerCompactOnReturnAction } from "./ComposerSendActions";
import type { PromptCacheFacts } from "@shared/compact-on-return";

const PromptStashMenu = lazy(async () => ({
  default: (await import("./PromptStashMenu")).PromptStashMenu,
}));
const PromptPresetMenu = lazy(async () => ({
  default: (await import("./PromptPresetMenu")).PromptPresetMenu,
}));
const ComposerSkillsMenu = lazy(async () => ({
  default: (await import("./ComposerSkillsMenu")).ComposerSkillsMenu,
}));
const ComposerSendActions = lazy(async () => ({
  default: (await import("./ComposerSendActions")).ConversationComposerSendActions,
}));

const SnapshotControl = lazy(async () => ({ default: (await import("./SnapshotControl")).SnapshotControl }));

const ComposerMoreMenu = lazy(async () => ({
  default: (await import("./ComposerMoreMenu")).ComposerMoreMenu,
}));

const COMPOSER_TOOL_MENUS: ReadonlySet<string> = new Set(["presets", "stash", "action"]);
const BRANCH_ATTENTION: readonly ComposerFoldKey[] = ["branch"];
const NO_ATTENTION: readonly ComposerFoldKey[] = [];

export function composerCheckoutStrip({
  showCheckoutContext,
  scratchWorkspace,
  newChatProjectPicker,
  worktreePath,
  repository,
}: {
  showCheckoutContext: boolean;
  scratchWorkspace: boolean;
  newChatProjectPicker: boolean;
  worktreePath: string | null;
  repository: boolean;
}): "hidden" | "branch" | "context" {
  if (!showCheckoutContext) return "hidden";
  if (newChatProjectPicker) return "context";
  if (scratchWorkspace) return "hidden";
  if (worktreePath) return "context";
  return repository ? "branch" : "hidden";
}

export function composerCheckoutBranch(
  conversation: Pick<Conversation, "branch" | "worktreePath">,
  checkoutBranch: string | null | undefined,
): string {
  return (conversation.worktreePath
    ? conversation.branch ?? checkoutBranch
    : checkoutBranch ?? conversation.branch) ?? "Detached HEAD";
}

export interface ComposerToolbarProps {
  onQueueCommand?: QueueCommandRunner;
  actions: ProjectAction[];
  disabled: boolean;
  running: boolean;
  attachmentCount: number;
  attachmentDisabled: boolean;
  attachmentImporting: boolean;
  onChooseAttachments: () => Promise<void>;
  imageInputUnavailableReason: string | null;
  onRunAction: (action: ProjectAction) => void;
  skills: readonly AgentSkillSummary[];
  skillsCapability: AgentWorkflowSkillsCapability | null;
  skillsLoading: boolean;
  skillsError: string | null;
  skillQuery: string | null;
  skillListboxId: string;
  activeSkillId: string | null;
  onListSkills: (forceReload?: boolean) => Promise<void>;
  onInsertSkill: (skill: AgentSkillSummary) => void;
  promptPresets: readonly PromptPreset[];
  promptPresetsEnabled: boolean;
  promptStashEnabled: boolean;
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
  showCheckoutContext: boolean;
  scratchWorkspace?: boolean;
  newChatProjectPicker?: NewChatProjectPicker;
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
  primaryAction: ComposerPrimaryActionState;
  compactOnReturn?: ComposerCompactOnReturnAction | null;
  compacting?: boolean;
  promptCache?: Pick<PromptCacheFacts, "lastRequestStartedAt" | "lifetimeMs" | "source"> | null;
  canSendQueuedNow: boolean;
  queuedTurnId: string | null;
  queuedTurnStatus: AgentTurnStatus | null;
  queuedTurnAuthoritative: boolean;
  onSendQueued: (
    content: string,
    attachments: ChatAttachment[],
  ) => Promise<unknown>;
  onReleaseAttachment: (attachmentId: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  onFocusInput?: () => void;
  awaitingInput?: boolean;
}

export function ComposerToolbar({
  actions,
  disabled,
  running,
  attachmentCount,
  attachmentDisabled,
  attachmentImporting,
  onChooseAttachments,
  imageInputUnavailableReason,
  onRunAction,
  skills,
  skillsCapability,
  skillsLoading,
  skillsError,
  skillQuery,
  skillListboxId,
  activeSkillId,
  onListSkills,
  onInsertSkill,
  promptPresets,
  promptPresetsEnabled,
  promptStashEnabled,
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
  showCheckoutContext,
  scratchWorkspace = false,
  newChatProjectPicker,
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
  primaryAction,
  compactOnReturn = null,
  compacting = false,
  promptCache = null,
  canSendQueuedNow,
  queuedTurnId,
  queuedTurnStatus,
  queuedTurnAuthoritative,
  onSendQueued,
  onQueueCommand,
  onReleaseAttachment,
  onSubmit,
  onStop,
  onFocusInput,
  awaitingInput = false,
}: ComposerToolbarProps): React.JSX.Element {
  const canSendAttachmentWhileRunning = supportsActiveParentFollowUp(
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
    handleComposerMenuNavigation,
    handleComposerMenuTriggerKeyDown,
  } = menuController;
  const checkoutModel = useContext(CheckoutBranchControlContext);
  const checkoutGitStatus = checkoutModel?.gitStatus ?? null;
  const checkoutStrip = composerCheckoutStrip({
    showCheckoutContext,
    scratchWorkspace,
    newChatProjectPicker: Boolean(newChatProjectPicker),
    worktreePath: conversation.worktreePath,
    repository: checkoutGitStatus
      ? checkoutGitStatus.isRepository
      : Boolean(checkoutModel?.project.repositoryRoot),
  });
  const railRef = useRef<HTMLDivElement>(null);
  const branchMenuRef = useRef<CheckoutBranchMenuOpener | null>(null);
  const showBranch = checkoutStrip !== "hidden" && !scratchWorkspace;
  const worktree = Boolean(conversation.worktreePath);
  const branchChip = showBranch
    ? checkoutBranchChip(
        visibleCheckoutBranch,
        checkoutModel,
        worktree,
        checkoutModel
          ? conversationContextMismatch(checkoutModel.project, checkoutModel.conversation, checkoutGitStatus) !== null
          : false,
      )
    : null;
  const { folded, exhausted } = useComposerChipFolding(
    railRef,
    branchChip?.attention ? BRANCH_ATTENTION : NO_ATTENTION,
  );
  const moreTrigger = (): HTMLButtonElement | null =>
    railRef.current?.querySelector<HTMLButtonElement>(".composer-more-trigger") ?? null;
  useEffect(() => {
    const more = moreTrigger();
    const moreShown = Boolean(more?.getClientRects().length);
    const active = document.activeElement;
    const focusHidden = active instanceof HTMLElement
      && Boolean(railRef.current?.contains(active))
      && active.getClientRects().length === 0;
    if (menu === "reasoning" || menu === "speed" || menu === "access" || menu === "mode") {
      if (folded.has(menu)) dismissMenu("context-change");
    }
    if (menu === "more" && !moreShown) {
      dismissMenu("context-change");
      if (focusHidden || active === document.body) onFocusInput?.();
    } else if (focusHidden) {
      if (moreShown) more?.focus({ preventScroll: true });
      else onFocusInput?.();
    }
  }, [dismissMenu, folded, menu, onFocusInput]);
  const toolsId = useId();
  const toolsOpen = useComposerToolsOpen();
  const toolsVisible = toolsOpen || (menu !== null && COMPOSER_TOOL_MENUS.has(menu));
  const hasTools = promptPresetsEnabled || promptStashEnabled || actions.length > 0;
  return (
    <div
      className="composer-toolbar"
      role="group"
      aria-label="Composer controls"
    >
      <div ref={railRef} className="composer-primary-rail">
        <div
          className="composer-options"
          role="group"
          aria-label="Model and run settings"
          data-fold-exhausted={exhausted ? "true" : undefined}
        >
          <ModelChooser
            routes={modelRoutes}
            selectedRoute={selectedModelRoute}
            configuration={{
              accessMode: conversation.accessMode,
              interactionMode: conversation.interactionMode,
              fastMode: selectedFastMode,
            }}
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
            folded={folded}
          />
          {checkoutStrip !== "hidden" && (
            <div
              className="composer-checkout-context"
              role="group"
              aria-label="Chat checkout context"
              data-checkout-context={checkoutStrip}
            >
              {newChatProjectPicker ? <ProjectPicker picker={newChatProjectPicker} /> : null}
              {showBranch && (
                <div
                  className="composer-branch-control"
                  data-composer-fold="branch"
                  data-folded={folded.has("branch") ? "true" : undefined}
                >
                  <CheckoutBranchSlot
                    branch={visibleCheckoutBranch}
                    worktree={worktree}
                    menuRef={branchMenuRef}
                    fallbackAnchor={moreTrigger}
                  />
                </div>
              )}
            </div>
          )}
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
              folded={folded}
              branch={branchChip
                ? { label: branchChip.text, available: branchChip.interactive, attention: branchChip.attention }
                : null}
              onOpenBranch={() => branchMenuRef.current?.() ?? false}
            />
          </Suspense>
        </div>
        {attachmentImporting && (
          <span className="provider-status" role="status">
            <LoadingMark size={14} aria-hidden="true" />
            <span>Adding attachments…</span>
          </span>
        )}
        <Suspense fallback={null}>
          <ComposerSkillsMenu
            skills={skills}
            capability={skillsCapability}
            loading={skillsLoading}
            error={skillsError}
            completion={skillQuery}
            listboxId={skillListboxId}
            activeSkillId={activeSkillId}
            disabled={disabled}
            running={running}
            menuController={menuController}
            onList={onListSkills}
            onInsert={onInsertSkill}
          />
        </Suspense>
        <div
          className="composer-actions"
          role="group"
          aria-label="Usage"
        >
        {selectedProvider ? (
          <UsageIndicator
            providerId={selectedProvider.id}
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
            promptCache={promptCache}
            onModeChange={onUsageDisplayModeChange}
          />
        ) : null}
        </div>
        {hasTools && <IconButton
          label="More tools"
          className="composer-tools-toggle"
          aria-expanded={toolsVisible}
          aria-controls={toolsId}
          onClick={() => {
            const next = !toolsVisible;
            if (!next && menu !== null && COMPOSER_TOOL_MENUS.has(menu)) dismissMenu("context-change");
            setComposerToolsOpen(next);
          }}
        >
          <Ellipsis size={16} />
        </IconButton>}
        <div id={toolsId} className="composer-more-tools" hidden={!hasTools || !toolsVisible}>
        <div
          className="composer-tools"
          role="group"
          aria-label="Add context"
        >
        {promptPresetsEnabled && (
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
        )}
        {promptStashEnabled && (
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
        )}
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
              onKeyDown={(event) =>
                handleComposerMenuTriggerKeyDown("action", event)}
            >
              <Wrench size={14} />
              <span>Actions</span>
              <ChevronDown size={14} />
            </button>
            {menu === "action" && (
              <div
                ref={(node) => setMenuPopover("action", node)}
                id={menuId("action")}
                className="composer-popover action-popover"
                role="menu"
                aria-label="Project actions"
                onKeyDown={handleComposerMenuNavigation}
              >
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
                    <Play size={16} />
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
        </div>
        <div className="composer-attach-actions" role="group" aria-label="Attach">
          <IconButton
            label={running
              ? imageInputUnavailableReason
                ? `Attach images. ${imageInputUnavailableReason}`
                : canSendAttachmentWhileRunning
                  ? "Attach follow-up images"
                  : "Attach queued images"
              : imageInputUnavailableReason
                ? `Attach documents or spreadsheets. ${imageInputUnavailableReason}`
                : "Attach images, documents, or spreadsheets"}
            onClick={() => void onChooseAttachments()}
            disabled={
              attachmentDisabled
              || attachmentCount >= MAX_ATTACHMENT_COUNT
              || (running && imageInputUnavailableReason !== null)
            }
          >
            <Paperclip size={16} />
          </IconButton>
          <Suspense fallback={null}><SnapshotControl conversationId={conversation.id} disabled={attachmentDisabled || attachmentCount >= MAX_ATTACHMENT_COUNT || imageInputUnavailableReason !== null} /></Suspense>
        </div>
      </div>
      <div className="composer-input-actions" role="group" aria-label="Message actions">
        <Suspense
          fallback={(
            <ComposerSendActionsFallback
              primaryAction={primaryAction}
              compactOnReturnMode={compactOnReturn?.mode ?? null}
              compacting={compacting}
              onSubmit={onSubmit}
              onStop={onStop}
              onFocusInput={onFocusInput}
              awaitingInput={awaitingInput}
            />
          )}
        >
          <ComposerSendActions
            conversationId={conversation.id}
            primaryAction={primaryAction}
            canSendQueuedNow={canSendQueuedNow}
            running={running}
            latestTurnId={queuedTurnId}
            latestTurnStatus={queuedTurnStatus}
            latestTurnAuthoritative={queuedTurnAuthoritative}
            compactOnReturn={compactOnReturn}
            compacting={compacting}
            onSendQueued={onSendQueued}
            onQueueCommand={onQueueCommand}
            onReleaseAttachment={onReleaseAttachment}
            onSubmit={onSubmit}
            onStop={onStop}
            onFocusInput={onFocusInput}
            awaitingInput={awaitingInput}
          />
        </Suspense>
      </div>
    </div>
  );
}
