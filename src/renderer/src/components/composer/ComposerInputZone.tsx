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

export interface ComposerInputZoneProps {
  routeReadiness: RouteReadiness;
  routeRepairing: boolean;
  disabled: boolean;
  onRunRouteRepair: () => Promise<void>;
  promptContext?: string | null;
  onClearPromptContext?: () => void;
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
  onUpdateConversation,
}: ComposerInputZoneProps): React.JSX.Element {
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
      {!running && slashMatch && (
        <div
          className="composer-suggestion-menu"
          role="listbox"
          aria-label="Composer commands"
        >
          {([
            { id: "plan", label: "Plan mode", mode: "plan" as const },
            { id: "build", label: "Build mode", mode: "build" as const },
          ]).filter(({ id }) =>
            id.startsWith(slashMatch[1].toLowerCase())).map((item) => (
            <button
              type="button"
              role="option"
              aria-selected="false"
              disabled={disabled || running}
              key={item.id}
              onClick={() => {
                void onUpdateConversation({
                  interactionMode: item.mode as InteractionMode,
                }).then(
                  () => onMessageChange(""),
                  () => undefined,
                );
              }}
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
