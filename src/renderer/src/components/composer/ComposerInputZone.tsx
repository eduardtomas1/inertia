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
  ChatAttachment,
  Conversation,
  InteractionMode,
  WorkspaceEntry,
} from "@shared/contracts";
import { MAX_CHAT_MESSAGE_CHARS } from "../../../../shared/diff-review";
import type { composerRouteReadiness } from "../../utils/composerReadiness";
import { promptContextDetail } from "../../utils/requestContext";
import { shouldSubmitComposerKey } from "../../utils/composerKeyboard";
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
  onImportAttachments: (files: File[]) => Promise<void>;
  onSubmit: () => Promise<void>;
  running: boolean;
  submissionPending: boolean;
  followUpPending: boolean;
  typedMessageLimit: number;
  messageFits: boolean;
  mentionMatch: RegExpExecArray | null;
  mentionResults: WorkspaceEntry[];
  onAddFileReference: (path: string) => void;
  slashMatch: RegExpExecArray | null;
  onCompactCommand: () => void;
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
  onImportAttachments,
  onSubmit,
  running,
  submissionPending,
  followUpPending,
  typedMessageLimit,
  messageFits,
  mentionMatch,
  mentionResults,
  onAddFileReference,
  slashMatch,
  onCompactCommand,
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
    { id: "compact", label: "Compact this chat's provider context", section: "provider", action: onCompactCommand, disabled: false, disabledWhileRunning: true },
  ];
  const matchingSlashCommands = slashMatch
    ? slashCommands.filter(({ id }) =>
        id.startsWith(slashMatch[1].toLowerCase()))
    : [];
  const slashCommandDisabled = (item: ComposerSlashCommand): boolean =>
    disabled || item.disabled || (running && item.disabledWhileRunning);
  const slashSearchKey = slashMatch?.[1].toLowerCase() ?? null;
  const selectableSlashCommands = matchingSlashCommands.filter((item) =>
    !slashCommandDisabled(item));
  const [highlightedSlashCommand, setHighlightedSlashCommand] = useState<{
    query: string;
    id: string;
  } | null>(null);
  const [dismissedSlashValue, setDismissedSlashValue] = useState<string | null>(
    null,
  );
  const highlightedSlashCommandId = highlightedSlashCommand?.query
    === slashSearchKey
    ? highlightedSlashCommand.id
    : selectableSlashCommands[0]?.id ?? null;
  const activeSlashCommand = selectableSlashCommands.find((item) =>
    item.id === highlightedSlashCommandId)
    ?? selectableSlashCommands[0]
    ?? null;
  const slashMenuVisible = Boolean(
    slashMatch && dismissedSlashValue !== message,
  );

  const moveSlashHighlight = (
    direction: "previous" | "next" | "first" | "last",
  ): void => {
    if (slashSearchKey === null || selectableSlashCommands.length === 0) return;
    const activeIndex = selectableSlashCommands.findIndex((item) =>
      item.id === activeSlashCommand?.id);
    let nextIndex = 0;
    if (direction === "last") nextIndex = selectableSlashCommands.length - 1;
    else if (direction === "previous") {
      nextIndex = activeIndex <= 0
        ? selectableSlashCommands.length - 1
        : activeIndex - 1;
    } else if (direction === "next") {
      nextIndex = activeIndex < 0 || activeIndex === selectableSlashCommands.length - 1
        ? 0
        : activeIndex + 1;
    }
    setHighlightedSlashCommand({
      query: slashSearchKey,
      id: selectableSlashCommands[nextIndex]!.id,
    });
  };
  const activateSlashCommand = (item: ComposerSlashCommand): void => {
    if (slashCommandDisabled(item)) return;
    setDismissedSlashValue(message);
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
            if (slashMenuVisible && slashMatch) {
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissedSlashValue(message);
                return;
              }
              if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                moveSlashHighlight(
                  event.key === "ArrowUp"
                    ? "previous"
                    : event.key === "ArrowDown"
                      ? "next"
                      : event.key === "End"
                        ? "last"
                        : "first",
                );
                return;
              }
              if (event.key === "Tab" && !event.shiftKey && activeSlashCommand) {
                event.preventDefault();
                activateSlashCommand(activeSlashCommand);
                return;
              }
            }
            if (
              slashMenuVisible
              && matchingSlashCommands.length > 0
              && shouldSubmitComposerKey(event)
            ) {
              event.preventDefault();
              if (activeSlashCommand) {
                activateSlashCommand(activeSlashCommand);
              }
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
          aria-label="Message"
          placeholder={running
            ? "Add a follow-up or attach images…"
            : "Ask anything, @ tag files, $ use skills, or / for commands…"}
        />
        {!messageFits && (
          <p className="composer-limit-warning" role="alert">
            This message exceeds the {MAX_CHAT_MESSAGE_CHARS.toLocaleString()} character limit.
          </p>
        )}
      </div>
      {!running && mentionMatch && mentionResults.length > 0 && (
        <div
          className="composer-suggestion-menu"
          role="listbox"
          aria-label="Project files"
        >
          <div className="popover-title">Reference a file</div>
          {mentionResults.slice(0, 8).map((entry) => (
            <button
              type="button"
              role="option"
              aria-selected="false"
              key={entry.path}
              onClick={() => {
                onMessageChange(message.replace(
                  /@[^\s@]*$/u,
                  `@${entry.path}${entry.kind === "directory" ? "/" : " "}`,
                ));
                if (entry.kind === "file") {
                  onAddFileReference(entry.path);
                }
              }}
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
              grouped={slashSearchKey === ""}
              onActiveItemChange={(id) => {
                setHighlightedSlashCommand({ query: slashSearchKey ?? "", id });
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
