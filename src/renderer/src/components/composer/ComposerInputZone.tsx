import type { RefObject } from "react";
import { MessageSquarePlus, RefreshCw, X } from "lucide-react";
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

interface ComposerSlashCommand {
  id: string;
  label: string;
  disabled: boolean;
  disabledWhileRunning: boolean;
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
    { id: "goal", label: "View or set this chat's goal", action: onOpenGoal, disabled: !goalAvailable, disabledWhileRunning: false },
    { id: "resume", label: "Resume a provider chat from this folder", action: onOpenResume, disabled: false, disabledWhileRunning: false },
    { id: "compact", label: "Compact this chat's provider context", action: onCompactCommand, disabled: false, disabledWhileRunning: true },
    { id: "plan", label: "Plan mode", mode: "plan", disabled: false, disabledWhileRunning: true },
    { id: "build", label: "Build mode", mode: "build", disabled: false, disabledWhileRunning: true },
  ];
  const matchingSlashCommands = slashMatch
    ? slashCommands.filter(({ id }) =>
        id.startsWith(slashMatch[1].toLowerCase()))
    : [];
  const selectedSlashCommand = matchingSlashCommands.find(
    ({ id }) => id === slashMatch?.[1].toLowerCase(),
  ) ?? (matchingSlashCommands.length === 1 ? matchingSlashCommands[0] : null);
  const slashCommandDisabled = (item: ComposerSlashCommand): boolean =>
    disabled || item.disabled || (running && item.disabledWhileRunning);
  const composerContextItemCount = attachments.length
    + Number(Boolean(promptContext))
    + Number(Boolean(previewContextUrl));
  const activateSlashCommand = (item: ComposerSlashCommand): void => {
    if (slashCommandDisabled(item)) return;
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
        {composerContextItemCount > 0 && (
          <section className="composer-context-tray" aria-label="Composer context">
            <header className="composer-context-tray-heading">
              <strong>Context</strong>
              <small>{composerContextItemCount} {composerContextItemCount === 1 ? "item" : "items"}</small>
            </header>
            <div className="composer-context-tray-items">
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
            </div>
          </section>
        )}
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
            {compactNotice.kind === "working" && (
              <span className="loading-mark" aria-hidden="true" />
            )}
            <span>{compactNotice.message}</span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(event) => onMessageChange(event.target.value)}
          onPaste={(event) => {
            if (!running && event.clipboardData.files.length > 0) {
              event.preventDefault();
              void onImportAttachments([...event.clipboardData.files]);
            }
          }}
          onKeyDown={(event) => {
            if (
              matchingSlashCommands.length > 0
              && shouldSubmitComposerKey(event)
            ) {
              event.preventDefault();
              if (selectedSlashCommand) {
                activateSlashCommand(selectedSlashCommand);
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
            ? "Add a follow-up while the agent works…"
            : "Ask Inertia to work with this project…"}
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
      {slashMatch && (
        <div
          className="composer-suggestion-menu"
          role="listbox"
          aria-label="Composer commands"
        >
          {matchingSlashCommands.map((item) => (
            <button
              type="button"
              role="option"
              aria-selected="false"
              disabled={slashCommandDisabled(item)}
              key={item.id}
              onClick={() => activateSlashCommand(item)}
            >
              <span>/{item.id}</span>
              <small>{item.label}</small>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
