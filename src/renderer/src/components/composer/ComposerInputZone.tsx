import { lazy, Suspense, useState, type RefObject } from "react";
import {
  Box,
  Check,
  CircleAlert,
  MessageSquarePlus,
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
import {
  RouteRepairIcon,
  routeRepairLabel,
} from "./config";
import { RouteChangeConfirmation } from "./RouteChangeConfirmation";
import type { PendingModelRoute } from "./types";

type RouteReadiness = ReturnType<typeof composerRouteReadiness>;

const ComposerCommandMenu = lazy(async () => ({
  default: (await import("./ComposerCommandMenu")).ComposerCommandMenu,
}));

interface ComposerSlashCommand {
  id: string;
  label: string;
  disabled: boolean;
  disabledWhileRunning: boolean;
  section: "built-in" | "provider";
  action?: () => void;
  mode?: InteractionMode;
}

export interface ComposerInputZoneProps {
  routeReadiness: RouteReadiness;
  routeRepairing: boolean;
  disabled: boolean;
  onRunRouteRepair: () => Promise<void>;
  promptContext?: string | null;
  onClearPromptContext?: () => void;
  previewContextUrl?: string | null;
  previewContextSelected: boolean;
  onTogglePreviewContext: () => void;
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
  submissionPending: boolean;
  followUpPending: boolean;
  typedMessageLimit: number;
  messageFits: boolean;
  mentionMatch: RegExpExecArray | null;
  mentionResults: WorkspaceEntry[];
  onAddFileReference: (path: string) => void;
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
  routeReadiness,
  routeRepairing,
  disabled,
  onRunRouteRepair,
  promptContext,
  onClearPromptContext,
  previewContextUrl,
  previewContextSelected,
  onTogglePreviewContext,
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
  submissionPending,
  followUpPending,
  typedMessageLimit,
  messageFits,
  mentionMatch,
  mentionResults,
  onAddFileReference,
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
  const slashCommands: ComposerSlashCommand[] = [
    { id: "goal", label: "View or set this chat's goal", section: "built-in", action: onOpenGoal, disabled: !goalAvailable, disabledWhileRunning: false },
    { id: "plan", label: "Switch this chat into plan mode", section: "built-in", mode: "plan", disabled: false, disabledWhileRunning: true },
    { id: "build", label: "Switch this chat back to build mode", section: "built-in", mode: "build", disabled: false, disabledWhileRunning: true },
    { id: "resume", label: "Resume a provider chat from this folder", section: "provider", action: onOpenResume, disabled: false, disabledWhileRunning: false },
    {
      id: "compact",
      label: compactUnavailableReason
        ? `Unavailable: ${compactUnavailableReason}`
        : "Compact this chat's provider context",
      section: "provider",
      action: onCompactCommand,
      disabled: compactUnavailableReason !== null,
      disabledWhileRunning: true,
    },
  ];
  const matchingSlashCommands = slashMatch
    ? slashCommands.filter(({ id }) =>
        id.startsWith(slashMatch[1].toLowerCase()))
    : [];
  const slashCommandDisabled = (item: ComposerSlashCommand): boolean =>
    disabled || item.disabled || (running && item.disabledWhileRunning);
  const selectableSlashCommands = matchingSlashCommands.filter((item) =>
    !slashCommandDisabled(item));
  const [highlightedSlashCommandId, setHighlightedSlashCommandId] = useState<string | null>(null);
  const [dismissedSuggestionValue, setDismissedSuggestionValue] = useState<string | null>(
    null,
  );
  const activeSlashCommand = selectableSlashCommands.find((item) =>
    item.id === highlightedSlashCommandId)
    ?? selectableSlashCommands[0]
    ?? null;
  const slashMenuVisible = Boolean(
    slashMatch && dismissedSuggestionValue !== message,
  );
  const mentionListboxId = `${skillListboxId}-files`;
  const visibleMentionResults = mentionResults.slice(0, 8);
  const [highlightedMentionPath, setHighlightedMentionPath] = useState<string | null>(null);
  const activeMention = visibleMentionResults.find(({ path }) =>
    path === highlightedMentionPath) ?? visibleMentionResults[0] ?? null;
  const mentionMenuVisible = Boolean(
    !running
    && mentionMatch
    && visibleMentionResults.length > 0
    && dismissedSuggestionValue !== message,
  );

  const moveMentionHighlight = (
    key: SidebarNavigationKey,
  ): void => {
    if (visibleMentionResults.length === 0) return;
    const activeIndex = visibleMentionResults.findIndex(({ path }) =>
      path === activeMention?.path);
    const nextIndex = nextSidebarNavigationIndex(
      activeIndex,
      key,
      visibleMentionResults.length,
    );
    setHighlightedMentionPath(visibleMentionResults[nextIndex]!.path);
  };
  const acceptMention = (entry: WorkspaceEntry): void => {
    onMessageChange(message.replace(
      /@[^\s@]*$/u,
      `@${entry.path}${entry.kind === "directory" ? "/" : " "}`,
    ));
    if (entry.kind === "file") onAddFileReference(entry.path);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const moveSlashHighlight = (
    key: SidebarNavigationKey,
  ): void => {
    if (selectableSlashCommands.length === 0) return;
    const activeIndex = selectableSlashCommands.findIndex((item) =>
      item.id === activeSlashCommand?.id);
    const nextIndex = nextSidebarNavigationIndex(
      activeIndex,
      key,
      selectableSlashCommands.length,
    );
    setHighlightedSlashCommandId(selectableSlashCommands[nextIndex]!.id);
  };
  const activateSlashCommand = (item: ComposerSlashCommand): void => {
    if (slashCommandDisabled(item)) return;
    setDismissedSuggestionValue(message);
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
            aria-label={promptContext.startsWith("Local review note for ")
              ? "Selected review note context"
              : "Selected diff context"}
          >
            <MessageSquarePlus size={13} />
            <span>
              <strong>
                {promptContext.startsWith("Local review note for ")
                  ? "Review note "
                  : "Diff selection "}
              </strong>
              <small>{promptContextDetail(promptContext)}</small>
            </span>
            <button
              type="button"
              aria-label={promptContext.startsWith("Local review note for ")
                ? "Remove selected review note context"
                : "Remove selected diff context"}
              onClick={onClearPromptContext}
            >
              <X size={12} />
            </button>
          </div>
        )}
        {previewContextUrl && (
          <button
            type="button"
            className={clsx(
              "composer-preview-context",
              previewContextSelected && "is-selected",
            )}
            aria-pressed={previewContextSelected}
            onClick={onTogglePreviewContext}
          >
            <span>
              <strong>{previewContextSelected ? "Preview attached" : "Attach current preview"}</strong>
              <small>{previewContextUrl}</small>
            </span>
            <b aria-hidden="true">{previewContextSelected ? "✓" : "+"}</b>
          </button>
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
            role={compactNotice.kind === "error" ? "alert" : "status"}
            aria-live={compactNotice.kind === "error" ? "assertive" : "polite"}
          >
            <span className="composer-compact-notice-icon" aria-hidden="true">
              <Box size={14} />
            </span>
            <span>{compactNotice.message}</span>
            <span className="composer-compact-notice-state" aria-hidden="true">
              {compactNotice.kind === "working" ? (
                <span className="composer-status-dots">
                  <i />
                  <i />
                  <i />
                </span>
              ) : compactNotice.kind === "success" ? (
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
          onChange={(event) => onMessageChange(event.target.value)}
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) {
              event.preventDefault();
              void onImportAttachments([...event.clipboardData.files]);
            }
          }}
          onKeyDown={(event) => {
            if (skillOpen && activeSkill && handleComposerSuggestionKey(
              event,
              dismissSkills,
              moveSkill,
              () => {
                acceptSkill(activeSkill);
                dismissSkills();
              },
            )) return;
            if (mentionMenuVisible && activeMention && handleComposerSuggestionKey(
              event,
              () => setDismissedSuggestionValue(message),
              moveMentionHighlight,
              () => acceptMention(activeMention),
            )) return;
            if (slashMenuVisible && slashMatch && handleComposerSuggestionKey(
              event,
              () => setDismissedSuggestionValue(message),
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
                slashMatch?.[1].toLowerCase() === "compact"
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
          role={skillOpen || mentionMenuVisible ? "combobox" : undefined}
          aria-autocomplete={skillOpen || mentionMenuVisible ? "list" : undefined}
          aria-expanded={skillOpen || mentionMenuVisible ? true : undefined}
          aria-controls={skillOpen
            ? skillListboxId
            : mentionMenuVisible ? mentionListboxId : undefined}
          aria-activedescendant={skillOpen && activeSkill
            ? `${skillListboxId}-${activeSkill.id}`
            : mentionMenuVisible && activeMention
              ? `${mentionListboxId}-${visibleMentionResults.indexOf(activeMention)}`
              : undefined}
          aria-label="Message"
          placeholder={running
            ? "Enter sends · Tab queues"
            : "Ask for follow-up changes or attach images"}
        />
        {!messageFits && (
          <p className="composer-limit-warning" role="alert">
            This message exceeds the {MAX_CHAT_MESSAGE_CHARS.toLocaleString()} character limit.
          </p>
        )}
      </div>
      {mentionMenuVisible && (
        <div
          id={mentionListboxId}
          className="composer-suggestion-menu"
          role="listbox"
          aria-label="Project files"
        >
          <div className="popover-title">Reference a file</div>
          {visibleMentionResults.map((entry, index) => (
            <button
              id={`${mentionListboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={entry.path === activeMention?.path}
              key={entry.path}
              onMouseEnter={() => setHighlightedMentionPath(entry.path)}
              onClick={() => acceptMention(entry)}
            >
              <span>{entry.path}</span>
              <small>{entry.kind}</small>
            </button>
          ))}
        </div>
      )}
      {slashMenuVisible && slashMatch && (
        <div className="composer-command-layer">
          <Suspense fallback={null}>
            <ComposerCommandMenu
              items={matchingSlashCommands.map((item) => ({
                id: item.id,
                label: `/${item.id}`,
                description: item.label,
                section: item.section,
                disabled: slashCommandDisabled(item),
              }))}
              activeItemId={activeSlashCommand?.id ?? null}
              grouped={slashMatch[1] === ""}
              onActiveItemChange={(id) => {
                setHighlightedSlashCommandId(id);
              }}
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
