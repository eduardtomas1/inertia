import { INTERFACE_LOCALE } from "../../lib/locale";
import { Fragment, lazy, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Box,
  Check,
  CircleAlert,
  MessageSquarePlus,
  MessagesSquare,
  RefreshCw,
  X,
} from "lucide-react";
import clsx from "clsx";
import type {
  AgentSkillSummary,
  ChatAttachment,
  Conversation,
  InteractionMode,
  WorkspaceEntry,
} from "@shared/contracts";
import type { ConversationContextSourceOption } from "../conversation-context/types";
import { MAX_CHAT_MESSAGE_CHARS } from "../../../../shared/diff-review";
import type { composerRouteReadiness } from "../../utils/composerReadiness";
import { promptContextDetail } from "../../utils/requestContext";
import {
  composerPromptHistoryDirection,
  handleComposerSuggestionKey,
  shouldSubmitComposerKey,
} from "../../utils/composerKeyboard";
import type { ComposerPromptHistoryDirection } from "./useComposerPromptHistory";
import {
  nextSidebarNavigationIndex,
  type SidebarNavigationKey,
} from "../../utils/sidebarModel";
import { ComposerAttachmentList } from "../ComposerAttachmentList";
import { ContextCompactionIcon } from "../ContextCompactionIcon";
import {
  RouteRepairIcon,
  routeRepairLabel,
} from "./config";
import { RouteChangeConfirmation } from "./RouteChangeConfirmation";
import type { PendingModelRoute } from "./types";
import type { ComposerCommandMenuItem } from "./ComposerCommandMenu";

type RouteReadiness = ReturnType<typeof composerRouteReadiness>;

const ComposerCommandMenu = lazy(async () => ({
  default: (await import("./ComposerCommandMenu")).ComposerCommandMenu,
}));

interface ComposerSlashCommand extends ComposerCommandMenuItem {
  action?: () => void;
  mode?: InteractionMode;
}

export interface ComposerInputZoneProps {
  contextCards?: ReactNode;
  routeReadiness: RouteReadiness;
  routeRepairing: boolean;
  disabled: boolean;
  onRunRouteRepair: () => Promise<void>;
  promptContext?: string | null;
  onClearPromptContext?: () => void;
  previewContextUrl?: string | null;
  previewContextSelected: boolean;
  onTogglePreviewContext: () => void;
  onDismissPreviewContext: () => void;
  attachments: ChatAttachment[];
  attachmentsDisabled?: boolean;
  pendingAttachmentIds?: ReadonlySet<string>;
  onRemoveAttachment: (attachment: ChatAttachment) => void;
  pendingRoute: PendingModelRoute | null;
  creatingRouteConversation: boolean;
  routeCancelRef: RefObject<HTMLButtonElement | null>;
  canCreateRouteConversation: boolean;
  routeCreationBlockedReason?: string | null;
  onDismissPendingRoute: () => void;
  onCreateRouteConversation: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  message: string;
  onMessageChange: (message: string) => void;
  onNavigatePromptHistory: (
    direction: ComposerPromptHistoryDirection,
  ) => boolean;
  onImportAttachments: (files: File[]) => Promise<void>;
  onSubmit: () => Promise<void>;
  canQueue: boolean;
  onQueue: () => void;
  running: boolean;
  imageInputUnavailable: boolean;
  submissionPending: boolean;
  followUpPending: boolean;
  typedMessageLimit: number;
  messageFits: boolean;
  conversationId: string;
  onMentionQuery: (query: string) => void;
  mentionResults: WorkspaceEntry[];
  chatSuggestions: readonly ConversationContextSourceOption[];
  onAddFileReference: (path: string) => void;
  onReferenceChat: (source: ConversationContextSourceOption) => Promise<boolean>;
  onSkillSelectionChange?: (editor: HTMLTextAreaElement) => void;
  skillOpen: boolean;
  activeSkill: AgentSkillSummary | null;
  skillListboxId: string;
  moveSkill: (key: SidebarNavigationKey) => void;
  acceptSkill: (skill: AgentSkillSummary) => void;
  dismissSkills: () => void;
  slashMatch: RegExpExecArray | null;
  onCompactCommand: () => void;
  compactUnavailableReason: string | null;
  compactNotice: {
    kind: "working" | "success" | "error";
    message: string;
  } | null;
  goalAvailable: boolean;
  onOpenGoal: () => void;
  onOpenResume: () => void;
  onUpdateConversation: (
    update: Partial<Pick<Conversation, "interactionMode">>,
  ) => Promise<void>;
}

export function ComposerInputZone({
  contextCards,
  routeReadiness,
  routeRepairing,
  disabled,
  onRunRouteRepair,
  promptContext,
  onClearPromptContext,
  previewContextUrl,
  previewContextSelected,
  onTogglePreviewContext,
  onDismissPreviewContext,
  attachments,
  attachmentsDisabled = false,
  pendingAttachmentIds,
  onRemoveAttachment,
  pendingRoute,
  creatingRouteConversation,
  routeCancelRef,
  canCreateRouteConversation,
  routeCreationBlockedReason = null,
  onDismissPendingRoute,
  onCreateRouteConversation,
  textareaRef,
  message,
  onMessageChange,
  onNavigatePromptHistory,
  onImportAttachments,
  onSubmit,
  canQueue,
  onQueue,
  running,
  imageInputUnavailable,
  submissionPending,
  followUpPending,
  typedMessageLimit,
  messageFits,
  conversationId,
  onMentionQuery,
  mentionResults,
  chatSuggestions,
  onAddFileReference,
  onReferenceChat,
  onSkillSelectionChange,
  skillOpen,
  activeSkill,
  skillListboxId,
  moveSkill,
  acceptSkill,
  dismissSkills,
  slashMatch,
  onCompactCommand,
  compactUnavailableReason,
  compactNotice,
  goalAvailable,
  onOpenGoal,
  onOpenResume,
  onUpdateConversation,
}: ComposerInputZoneProps): React.JSX.Element {
  const currentDraft = useRef({ conversationId, message });
  currentDraft.current = { conversationId, message };
  const mentionMatch = /(?:^|\s)@([^\s@]{1,200})$/u.exec(message);
  const mentionQueryText = mentionMatch?.[1] ?? "";
  useEffect(() => { onMentionQuery(mentionQueryText); }, [mentionQueryText, onMentionQuery]);
  const modeChangesDisabled = disabled || running;
  const slashQuery = slashMatch?.[1].toLowerCase();
  const slashCommands: ComposerSlashCommand[] = slashMatch ? [
    { id: "goal", description: "View or set this chat's goal", section: "built-in", action: onOpenGoal, disabled: disabled || !goalAvailable },
    { id: "plan", description: "Switch this chat into plan mode", section: "built-in", mode: "plan", disabled: modeChangesDisabled },
    { id: "build", description: "Switch this chat back to build mode", section: "built-in", mode: "build", disabled: modeChangesDisabled },
    { id: "resume", description: "Resume a provider chat from this folder", section: "provider", action: onOpenResume, disabled },
    {
      id: "compact",
      description: compactUnavailableReason
        ? `Unavailable: ${compactUnavailableReason}`
        : "Compact this chat's provider context",
      section: "provider",
      action: onCompactCommand,
      disabled: modeChangesDisabled || compactUnavailableReason !== null,
    },
  ] : [];
  const matchingSlashCommands = slashMatch
    ? slashCommands.filter(({ id }) =>
        id.startsWith(slashQuery!))
    : [];
  const selectableSlashCommands = matchingSlashCommands.filter(({ disabled }) => !disabled);
  const [highlightedSlashCommandId, setHighlightedSlashCommandId] = useState<string | null>(null);
  const [dismissedSuggestionValue, setDismissedSuggestionValue] = useState<string | null>(
    null,
  );
  const dismissSuggestions = (): void => setDismissedSuggestionValue(message);
  const activeSlashCommand = selectableSlashCommands.find((item) =>
    item.id === highlightedSlashCommandId)
    ?? selectableSlashCommands[0]
    ?? null;
  const slashMenuVisible = Boolean(
    slashMatch && dismissedSuggestionValue !== message,
  );
  const mentionListboxId = `${skillListboxId}-files`;
  const mentionQuery = (mentionMatch?.[1] ?? "").toLowerCase();
  const chatMentionResults = chatSuggestions
    .filter(({ conversationTitle, archived }) =>
      !archived && conversationTitle.toLowerCase().includes(mentionQuery))
    .slice(0, 4);
  const visibleMentionResults = mentionResults.slice(0, 8);
  const mentionOptions = [
    ...chatMentionResults.map((source) => ({
      id: `chat:${source.conversationId}`,
      kind: "chat" as const,
      source,
    })),
    ...visibleMentionResults.map((entry) => ({
      id: `file:${entry.path}`,
      kind: "file" as const,
      entry,
    })),
  ];
  const [highlightedMentionId, setHighlightedMentionId] = useState<string | null>(null);
  const activeMention = mentionOptions.find(({ id }) =>
    id === highlightedMentionId) ?? mentionOptions[0] ?? null;
  const mentionMenuVisible = Boolean(
    !running
    && mentionMatch
    && mentionOptions.length > 0
    && dismissedSuggestionValue !== message,
  );
  const reviewNoteContext = promptContext?.startsWith("Local review note for ");
  const contextKind = reviewNoteContext ? "review note" : "diff";
  const previewDismissLabel = previewContextSelected
    ? "Remove attached preview" : "Dismiss preview suggestion";
  const suggestionMenuVisible = skillOpen || mentionMenuVisible;
  const compactWorking = compactNotice?.kind === "working";
  const compactError = compactNotice?.kind === "error";

  const moveMentionHighlight = (
    key: SidebarNavigationKey,
  ): void => {
    if (mentionOptions.length === 0) return;
    const nextIndex = nextSidebarNavigationIndex(
      mentionOptions.indexOf(activeMention!),
      key,
      mentionOptions.length,
    );
    setHighlightedMentionId(mentionOptions[nextIndex]!.id);
  };
  const acceptMention = (option: (typeof mentionOptions)[number]): void => {
    if (option.kind === "chat") {
      void onReferenceChat(option.source).then((created) => {
        // Completion belongs to the draft that requested this reference. Keep
        // the mention on failure, after navigation, or after further typing.
        if (created && textareaRef.current?.isConnected
          && currentDraft.current.conversationId === conversationId
          && currentDraft.current.message === message && textareaRef.current.value === message) {
          onMessageChange(message.replace(/@[^\s@]*$/u, ""));
        }
      });
    } else {
      onMessageChange(message.replace(
        /@[^\s@]*$/u,
        `@${option.entry.path}${option.entry.kind === "directory" ? "/" : " "}`,
      ));
      if (option.entry.kind === "file") onAddFileReference(option.entry.path);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const moveSlashHighlight = (
    key: SidebarNavigationKey,
  ): void => {
    if (selectableSlashCommands.length === 0) return;
    const nextIndex = nextSidebarNavigationIndex(
      selectableSlashCommands.indexOf(activeSlashCommand!),
      key,
      selectableSlashCommands.length,
    );
    setHighlightedSlashCommandId(selectableSlashCommands[nextIndex]!.id);
  };
  const activateSlashCommand = (item: ComposerSlashCommand): void => {
    if (item.disabled) return;
    dismissSuggestions();
    if (item.action) {
      item.action();
      return;
    }
    if (!item.mode) return;
    void onUpdateConversation({ interactionMode: item.mode }).then(
      () => onMessageChange(""),
      () => undefined,
    );
  };

  return (
    <>
      <div className="composer-input-zone" data-composer-zone="input">
        {contextCards}
        {!routeReadiness.ready && (
          <div
            className="provider-readiness"
            role="status"
            aria-live="polite"
            data-transient={routeReadiness.transient}
            data-route-repair={routeReadiness.action ?? "none"}
          >
            <span className={clsx(
              "route-readiness-badge",
              routeReadiness.transient ? "is-checking" : "is-attention",
            )}>
              {routeReadiness.transient && (
                <RefreshCw size={11} className="is-spinning" aria-hidden="true" />
              )}
              {routeReadiness.badge}
            </span>
            <span className="provider-readiness-copy">
              <strong>{routeReadiness.title}</strong>
              <small title={routeReadiness.detail}>{routeReadiness.detail}</small>
            </span>
            {routeReadiness.action && (
              <button
                type="button"
                className="secondary-button provider-readiness-action"
                aria-label={`${routeRepairLabel(routeReadiness.action)} — ${routeReadiness.title}`}
                disabled={disabled || routeRepairing}
                onClick={() => {
                  void onRunRouteRepair().catch(() => undefined);
                }}
              >
                <RouteRepairIcon
                  action={routeReadiness.action}
                  pending={routeRepairing}
                />
                {routeRepairing
                  ? routeReadiness.action === "probe"
                    ? "Probing…"
                    : "Refreshing…"
                  : routeRepairLabel(routeReadiness.action)}
              </button>
            )}
          </div>
        )}
        {promptContext && (
          <div
            className="composer-context"
            aria-label={`Selected ${contextKind} context`}
          >
            <MessageSquarePlus size={13} />
            <span>
              <strong>
                {reviewNoteContext
                  ? "Review note "
                  : "Diff selection "}
              </strong>
              <small>{promptContextDetail(promptContext)}</small>
            </span>
            <button
              type="button"
              aria-label={`Remove selected ${contextKind} context`}
              onClick={onClearPromptContext}
            >
              <X size={12} />
            </button>
          </div>
        )}
        {previewContextUrl && (
          <div
            className={clsx(
              "composer-preview-context",
              previewContextSelected && "is-selected",
            )}
          >
            <button
              type="button"
              className="composer-preview-context-toggle"
              aria-pressed={previewContextSelected}
              onClick={onTogglePreviewContext}
            >
              <span>
                <strong>{previewContextSelected ? "Preview attached" : "Attach current preview"}</strong>
                <small>{previewContextUrl}</small>
              </span>
              <b aria-hidden="true">{previewContextSelected ? "✓" : "+"}</b>
            </button>
            <button
              type="button"
              className="composer-preview-context-dismiss"
              aria-label={previewDismissLabel}
              title={previewDismissLabel}
              onClick={onDismissPreviewContext}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <ComposerAttachmentList
          attachments={attachments}
          disabled={attachmentsDisabled}
          pendingAttachmentIds={pendingAttachmentIds}
          onRemove={onRemoveAttachment}
        />
        {pendingRoute && (
          <RouteChangeConfirmation
            pendingRoute={pendingRoute}
            creating={creatingRouteConversation}
            cancelRef={routeCancelRef}
            canCreate={canCreateRouteConversation}
            blockedReason={routeCreationBlockedReason}
            onDismiss={onDismissPendingRoute}
            onCreate={onCreateRouteConversation}
          />
        )}
        {compactNotice && (
          <div
            className={clsx(
              "composer-compact-notice",
              `is-${compactNotice.kind}`,
            )}
            role={compactError ? "alert" : "status"}
            aria-live={compactError ? "assertive" : "polite"}
          >
            <span className="composer-compact-notice-icon" aria-hidden="true">
              {compactWorking ? <ContextCompactionIcon /> : <Box size={14} />}
            </span>
            <span>{compactNotice.message}</span>
            <span className="composer-compact-notice-state" aria-hidden="true">
              {compactWorking ? null : compactNotice.kind === "success" ? (
                <Check size={13} />
              ) : (
                <CircleAlert size={13} />
              )}
            </span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={message}
          onFocus={() => {
            void import("./ComposerCommandMenu");
          }}
          onSelect={(event) => onSkillSelectionChange?.(event.currentTarget)}
          onChange={(event) => {
            onMessageChange(event.target.value);
            onSkillSelectionChange?.(event.currentTarget);
          }}
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) {
              event.preventDefault();
              void onImportAttachments([...event.clipboardData.files]);
            }
          }}
          onKeyDown={(event) => {
            if (skillOpen && handleComposerSuggestionKey(
              event,
              dismissSkills,
              moveSkill,
              activeSkill ? () => {
                acceptSkill(activeSkill);
                dismissSkills();
              } : undefined,
            )) return;
            if (mentionMenuVisible && activeMention && handleComposerSuggestionKey(
              event,
              dismissSuggestions,
              moveMentionHighlight,
              () => acceptMention(activeMention),
            )) return;
            if (slashMenuVisible && slashMatch && handleComposerSuggestionKey(
              event,
              dismissSuggestions,
              moveSlashHighlight,
              activeSlashCommand
                ? () => activateSlashCommand(activeSlashCommand)
                : undefined,
              false,
            )) return;
            if (
              slashMenuVisible
              && matchingSlashCommands.length > 0
              && shouldSubmitComposerKey(event)
            ) {
              event.preventDefault();
              if (activeSlashCommand) {
                activateSlashCommand(activeSlashCommand);
              } else if (
                slashQuery === "compact"
                && compactUnavailableReason
              ) {
                void onSubmit();
              }
              return;
            }
            const historyDirection = composerPromptHistoryDirection(
              event,
              event.currentTarget,
            );
            if (
              !submissionPending
              && !followUpPending
              && historyDirection
              && onNavigatePromptHistory(historyDirection)
            ) {
              event.preventDefault();
              return;
            }
            if (
              canQueue
              && event.key === "Tab"
              && !event.shiftKey
              && !(event.ctrlKey || event.metaKey || event.altKey)
              && !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onQueue();
              return;
            }
            if (shouldSubmitComposerKey(event)) {
              event.preventDefault();
              void onSubmit();
            }
          }}
          rows={1}
          maxLength={typedMessageLimit}
          disabled={disabled}
          readOnly={submissionPending || followUpPending}
          role={suggestionMenuVisible ? "combobox" : undefined}
          aria-autocomplete={suggestionMenuVisible ? "list" : undefined}
          aria-expanded={suggestionMenuVisible || undefined}
          aria-controls={skillOpen
            ? skillListboxId
            : mentionMenuVisible ? mentionListboxId : undefined}
          aria-activedescendant={skillOpen && activeSkill
            ? `${skillListboxId}-${activeSkill.id}`
            : mentionMenuVisible && activeMention
              ? `${mentionListboxId}-${mentionOptions.indexOf(activeMention)}`
              : undefined}
          aria-label="Message"
          placeholder={running
            ? "Enter sends · Tab queues"
            : imageInputUnavailable
              ? "Ask for follow-up changes"
              : "Ask for follow-up changes or attach images"}
        />
        {!messageFits && (
          <p className="composer-limit-warning" role="alert">
            This message exceeds the {MAX_CHAT_MESSAGE_CHARS.toLocaleString(INTERFACE_LOCALE)} character limit.
          </p>
        )}
      </div>
      {mentionMenuVisible && (
        <div
          id={mentionListboxId}
          className="composer-suggestion-menu"
          role="listbox"
          aria-label={chatMentionResults.length > 0
            ? "Chats and project files"
            : "Project files"}
        >
          {chatMentionResults.length > 0 && (
            <div className="popover-title">Reference a chat</div>
          )}
          {mentionOptions.map((option, index) => (
            <Fragment key={option.id}>
              {option.kind === "file" && index === chatMentionResults.length && (
                <div className="popover-title">Reference a file</div>
              )}
              <button
                id={`${mentionListboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={option.id === activeMention?.id}
                onMouseEnter={() => setHighlightedMentionId(option.id)}
                onClick={() => acceptMention(option)}
              >
                {option.kind === "chat"
                  ? (
                    <>
                      <span className="composer-suggestion-chat">
                        <MessagesSquare size={11} aria-hidden="true" />
                        {option.source.conversationTitle}
                      </span>
                      <small>
                        {option.source.projectName}
                        {option.source.workspaceRelation === "different-workspace"
                          ? " · different workspace"
                          : ""}
                      </small>
                    </>
                  )
                  : (
                    <>
                      <span>{option.entry.path}</span>
                      <small>{option.entry.kind}</small>
                    </>
                  )}
              </button>
            </Fragment>
          ))}
        </div>
      )}
      {slashMenuVisible && slashMatch && (
        <div className="composer-command-layer">
          <Suspense fallback={null}>
            <ComposerCommandMenu
              items={matchingSlashCommands}
              activeItemId={activeSlashCommand?.id ?? null}
              grouped={slashMatch[1] === ""}
              onActiveItemChange={setHighlightedSlashCommandId}
              onSelect={(id) => {
                const item = matchingSlashCommands.find((candidate) =>
                  candidate.id === id);
                if (item) activateSlashCommand(item);
              }}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
