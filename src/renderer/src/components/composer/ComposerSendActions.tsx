import {
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { TooltipButton } from "../TooltipButton";
import type { ChatAttachment } from "@shared/contracts";
import { InertiaMorphIcon } from "../motion/InertiaMorphIcon";
import {
  arrowUpMorphIcon,
  loaderCircleMorphIcon,
  squareMorphIcon,
} from "../motion/lucideMorphData";
import type { ComposerPrimaryActionState } from "../../utils/composerPrimaryAction";
import type { AgentTurnStatus } from "../../../../shared/turn-lifecycle";
import "./ComposerSendActions.css";
import type { QueueCommandRunner } from "./runtimeQueueClient";

const ComposerQueuedActions = lazy(async () => ({
  default: (await import("./ComposerQueuedActions")).ComposerQueuedActions,
}));

function primaryPresentation(state: ComposerPrimaryActionState) {
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
  if (state === "stop-and-send") {
    return {
      action: "stop-and-send" as const,
      busy: false,
      disabled: false,
      icon: squareMorphIcon,
      iconState: "stop",
      label: "Stop and send",
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
    icon: arrowUpMorphIcon,
    iconState: "send",
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
  onQueueCommand,
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
  onQueueCommand?: QueueCommandRunner;
  onReleaseAttachment: (attachmentId: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  const [queueHost, setQueueHost] = useState<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const composer = primaryRef.current?.closest<HTMLElement>(".composer");
    setQueueHost(composer?.querySelector<HTMLElement>(".composer-queue-slot") ?? composer ?? null);
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
  const presentation = primaryPresentation(primaryAction);
  return (
    <>
      <Suspense fallback={null}>
        <ComposerQueuedActions
          conversationId={conversationId}
          canSendQueuedNow={canSendQueuedNow}
          running={running}
          latestTurnId={latestTurnId}
          latestTurnStatus={latestTurnStatus}
          latestTurnAuthoritative={latestTurnAuthoritative}
          queueHost={queueHost}
          onSendQueued={onSendQueued}
          onQueueCommand={onQueueCommand}
          onReleaseAttachment={onReleaseAttachment}
        />
      </Suspense>
      <TooltipButton
        ref={primaryRef}
        tooltip={presentation.label}
        aria-label={presentation.label}
        className={`icon-button send-button${
          presentation.action !== "send" ? " stop-button" : ""
        }${presentation.iconState === "sending" ? " send-button-loading" : ""}`}
        data-composer-action-state={primaryAction}
        data-motion-state={presentation.iconState}
        aria-busy={presentation.busy}
        onClick={() => {
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
      </TooltipButton>
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
