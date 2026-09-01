import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, Paperclip, Trash2 } from "lucide-react";
import type { ChatAttachment } from "@shared/contracts";
import { InertiaMorphIcon } from "../motion/InertiaMorphIcon";
import {
  loaderCircleMorphIcon,
  sendHorizontalMorphIcon,
  sendMorphIcon,
  squareMorphIcon,
} from "../motion/lucideMorphData";
import type { ComposerPrimaryActionState } from "../../utils/composerPrimaryAction";
import type { AgentTurnStatus } from "../../../../shared/turn-lifecycle";
import {
  QUEUED_PROMPTS_CHANGED_EVENT,
  composerQueueKey,
  readComposerQueue,
  removeComposerQueuedPrompt,
  takeAllSessionQueuedMedia,
} from "./composerQueuedPrompts";
import "./ComposerSendActions.css";

function primaryPresentation(
  state: ComposerPrimaryActionState,
  intent: boolean,
) {
  if (state === "stop-ready" || state === "stop-pending") {
    return {
      action: "stop" as const,
      busy: state === "stop-pending",
      disabled: state === "stop-pending",
      icon: squareMorphIcon,
      iconState: "stop",
      label: state === "stop-pending" ? "Stopping agent" : "Stop agent",
    };
  }
  if (state === "submitting") {
    return {
      action: "send" as const,
      busy: true,
      disabled: true,
      icon: loaderCircleMorphIcon,
      iconState: "sending",
      label: "Sending message",
    };
  }
  return {
    action: "send" as const,
    busy: false,
    disabled: state === "send-disabled",
    icon: intent && state === "send-ready"
      ? sendHorizontalMorphIcon
      : sendMorphIcon,
    iconState: intent && state === "send-ready" ? "send-intent" : "send",
    label: "Send message",
  };
}

export function ComposerSendActions({
  conversationId,
  primaryAction,
  canSendQueuedNow,
  running,
  latestTurnId,
  latestTurnStatus,
  latestTurnAuthoritative = true,
  onSendQueued,
  onReleaseAttachment,
  onSubmit,
  onStop,
}: {
  conversationId: string;
  primaryAction: ComposerPrimaryActionState;
  canSendQueuedNow: boolean;
  running: boolean;
  latestTurnId: string | null;
  latestTurnStatus: AgentTurnStatus | null;
  latestTurnAuthoritative?: boolean;
  onSendQueued: (
    content: string,
    attachments: ChatAttachment[],
  ) => Promise<unknown>;
  onReleaseAttachment: (attachmentId: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  const [intent, setIntent] = useState(false);
  const [queuedPrompts, setQueuedPrompts] = useState(() =>
    readComposerQueue(conversationId));
  const [queueSendingId, setQueueSendingId] = useState<string | null>(null);
  const [queueHost, setQueueHost] = useState<HTMLElement | null>(null);
  const queueSendingRef = useRef<string | null>(null);
  const conversationIdRef = useRef(conversationId);
  const autoQueuedTurnRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;
  const syncQueue = useCallback((): void => {
    const next = readComposerQueue(conversationId);
    setQueuedPrompts(next);
  }, [conversationId]);
  useEffect(() => {
    queueSendingRef.current = null;
    autoQueuedTurnRef.current = null;
    setQueueSendingId(null);
    syncQueue();
    const onStorage = (event: StorageEvent): void => {
      if (event.key === composerQueueKey(conversationId)) syncQueue();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(QUEUED_PROMPTS_CHANGED_EVENT, syncQueue);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(QUEUED_PROMPTS_CHANGED_EVENT, syncQueue);
    };
  }, [conversationId, syncQueue]);
  useEffect(() => {
    const releaseQueuedMedia = (): void => {
      for (const prompt of takeAllSessionQueuedMedia()) {
        for (const attachment of prompt.attachments) {
          void onReleaseAttachment(attachment.id);
        }
      }
    };
    window.addEventListener("beforeunload", releaseQueuedMedia);
    return () => window.removeEventListener("beforeunload", releaseQueuedMedia);
  }, [onReleaseAttachment]);
  const removeQueued = useCallback((
    promptId: string,
    releaseAttachments = true,
  ): void => {
    const removed = removeComposerQueuedPrompt(conversationId, promptId);
    if (!removed || !releaseAttachments) return;
    for (const attachment of removed.attachments) {
      void onReleaseAttachment(attachment.id);
    }
  }, [conversationId, onReleaseAttachment]);
  const sendQueued = useCallback(async (promptId: string): Promise<void> => {
    const dispatch = async (): Promise<void> => {
      if (queueSendingRef.current || !canSendQueuedNow) return;
      const queued = readComposerQueue(conversationId).find(
        ({ id }) => id === promptId,
      );
      if (!queued) return;
      queueSendingRef.current = promptId;
      setQueueSendingId(promptId);
      try {
        await onSendQueued(queued.content, queued.attachments);
        removeQueued(promptId, false);
      } catch {
        // The workspace owns the error surface; keep the draft for retry.
      } finally {
        if (
          conversationIdRef.current === conversationId
          && queueSendingRef.current === promptId
        ) {
          queueSendingRef.current = null;
          setQueueSendingId(null);
        }
      }
    };
    if (!navigator.locks) {
      await dispatch();
      return;
    }
    await navigator.locks.request(
      `inertia:queued-prompt:${conversationId}`,
      { ifAvailable: true },
      async (lock) => {
        if (lock) await dispatch();
      },
    );
  }, [canSendQueuedNow, conversationId, onSendQueued, removeQueued]);
  useEffect(() => {
    const queued = queuedPrompts[0];
    if (
      running
      || queueSendingRef.current
      || !canSendQueuedNow
      || !queued
      || !latestTurnId
      || latestTurnStatus !== "completed"
      || !latestTurnAuthoritative
    ) return;
    const terminalKey = `${conversationId}:${latestTurnId}`;
    if (autoQueuedTurnRef.current === terminalKey) return;
    autoQueuedTurnRef.current = terminalKey;
    void sendQueued(queued.id);
  }, [
    canSendQueuedNow,
    conversationId,
    latestTurnId,
    latestTurnAuthoritative,
    latestTurnStatus,
    queuedPrompts,
    running,
    sendQueued,
  ]);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    setQueueHost(primaryRef.current?.closest<HTMLElement>(".composer") ?? null);
  }, [conversationId]);
  const focusedElement = document.activeElement;
  const focusedGroup = focusedElement?.closest(".composer-actions");
  const focusedAction = focusedElement?.classList.contains("send-button")
    ? "primary"
    : null;
  useLayoutEffect(() => {
    const group = primaryRef.current?.closest<HTMLElement>(".composer-actions");
    if (group !== focusedGroup || document.activeElement !== document.body) return;
    if (focusedAction === "primary") primaryRef.current?.focus();
  }, [focusedAction, focusedGroup]);
  const presentation = primaryPresentation(primaryAction, intent);
  const queued = queuedPrompts[0] ?? null;
  const queueElement = queued ? (
    <div className="composer-queue" role="list" aria-label="Queued messages">
      <div
        className={`composer-queue-item${
          queued.attachments.length > 0 ? " has-media" : ""
        }`}
        role="listitem"
      >
        <CornerDownRight size={15} aria-hidden="true" />
        <span className="composer-queue-copy" title={queued.content}>
          {queued.content}
        </span>
        {queued.attachments.length > 0 && (
          <span
            className="composer-queue-media"
            title={queued.attachments.map(({ name }) => name).join("\n")}
          >
            <Paperclip size={13} aria-hidden="true" />
            {queued.attachments.length === 1
              ? "1 image"
              : `${queued.attachments.length} images`}
          </span>
        )}
        <small className="composer-queue-count">
          {queuedPrompts.length === 1 ? "Queued" : `1 of ${queuedPrompts.length}`}
        </small>
        <button
          type="button"
          className="composer-queue-send"
          aria-label="Send queued message now"
          disabled={!canSendQueuedNow || queueSendingId !== null}
          onClick={() => void sendQueued(queued.id)}
        >
          {queueSendingId === queued.id ? "Sending…" : "Send now"}
        </button>
        <button
          type="button"
          className="composer-queue-remove"
          aria-label="Remove queued message"
          disabled={queueSendingId === queued.id}
          onClick={() => removeQueued(queued.id)}
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  ) : null;
  return (
    <>
      {queueElement && (queueHost ? createPortal(queueElement, queueHost) : queueElement)}
      <button
        ref={primaryRef}
        type="button"
        aria-label={presentation.label}
        title={presentation.label}
        className={`icon-button send-button${
          presentation.action === "stop" ? " stop-button" : ""
        }${presentation.iconState === "sending" ? " send-button-loading" : ""}`}
        data-composer-action-state={primaryAction}
        data-motion-state={presentation.iconState}
        aria-busy={presentation.busy}
        onPointerEnter={() => setIntent(true)}
        onPointerLeave={() => setIntent(false)}
        onFocus={() => setIntent(true)}
        onBlur={() => setIntent(false)}
        onClick={() => {
          setIntent(false);
          if (presentation.action === "stop") void onStop();
          else void onSubmit();
        }}
        disabled={presentation.disabled}
      >
        <InertiaMorphIcon
          className="composer-send-motion-icon"
          icon={presentation.icon}
          iconState={presentation.iconState}
          size={16}
        />
      </button>
    </>
  );
}

export function ConversationComposerSendActions({
  conversationId,
  ...props
}: React.ComponentProps<typeof ComposerSendActions> & {
  conversationId: string;
}): React.JSX.Element {
  return <ComposerSendActions {...props} conversationId={conversationId} />;
}
