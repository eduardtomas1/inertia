import {
  lazy,
  Suspense,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { IconNode } from "morphicons/react";
import { TooltipButton } from "../TooltipButton";
import type { ChatAttachment, ProviderInfo } from "@shared/contracts";
import { InertiaMorphIcon } from "../motion/InertiaMorphIcon";
import {
  arrowUpMorphIcon,
  loaderCircleMorphIcon,
  squareMorphIcon,
} from "../motion/lucideMorphData";
import type { ComposerPrimaryActionState } from "../../utils/composerPrimaryAction";
import type { AgentTurnStatus } from "../../../../shared/turn-lifecycle";
import "./ComposerSendActions.css";
import type { QueueCommandRunner, QueuedMessageEdit } from "./runtimeQueueClient";

const playMorphIcon = [
  ["path", { d: "M6 3 20 12 6 21 6 3Z" }],
] as const satisfies IconNode;

const ComposerQueuedActions = lazy(async () => ({
  default: (await import("./ComposerQueuedActions")).ComposerQueuedActions,
}));

export interface ComposerCompactOnReturnAction {
  mode: "compact" | "full";
  tooltip: string;
  onToggle: () => void;
  toggleVisible: boolean;
}

export const COMPACT_AND_SEND = "Compact and send";
export const COMPACTING_BEFORE_SENDING = "Compacting before sending";

function primaryPresentation(
  state: ComposerPrimaryActionState,
  compactOnReturn: ComposerCompactOnReturnAction | null,
  compacting: boolean,
  awaitingInput: boolean,
) {
  if (state === "stop-ready" || state === "stop-pending") {
    return {
      action: "stop" as const,
      busy: state === "stop-pending",
      disabled: false,
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
  if (state === "resume-ready" || state === "resume-pending") {
    return {
      action: "resume" as const,
      busy: state === "resume-pending",
      disabled: state === "resume-pending",
      icon: state === "resume-pending" ? loaderCircleMorphIcon : playMorphIcon,
      iconState: state === "resume-pending" ? "sending" : "resume",
      label: state === "resume-pending" ? "Resuming queue" : "Resume queue",
    };
  }
  if (state === "submitting") {
    return {
      action: "send" as const,
      busy: true,
      disabled: true,
      icon: loaderCircleMorphIcon,
      iconState: "sending",
      label: compacting ? COMPACTING_BEFORE_SENDING : "Sending message",
    };
  }
  const offered = state === "send-ready" && compactOnReturn !== null;
  const compactAndSend = offered && compactOnReturn.mode === "compact";
  const resting = state === "send-disabled" && awaitingInput;
  return {
    action: "send" as const,
    busy: false,
    disabled: state === "send-disabled" && !resting,
    resting,
    icon: arrowUpMorphIcon,
    iconState: "send",
    label: compactAndSend ? COMPACT_AND_SEND : offered ? "Send" : "Send message",
    tooltip: compactAndSend ? compactOnReturn.tooltip : undefined,
    visibleLabel: offered,
  };
}

function FullHistoryToggle({ action }: { action: ComposerCompactOnReturnAction }): React.JSX.Element {
  return (
    <TooltipButton
      className="composer-history-chip"
      data-history-mode={action.mode}
      aria-pressed={action.mode === "full"}
      tooltip="Send this message with the whole history instead of compacting first"
      onClick={action.onToggle}
    >
      Full history
    </TooltipButton>
  );
}

export function ComposerSendActions({
  conversationId,
  primaryAction,
  canSendQueuedNow,
  running,
  canSteer,
  canInterrupt,
  providerSwitchWaitsForTurn,
  hasPendingQuestionOrApproval,
  resuming,
  onResume,
  providers,
  queueHost: explicitQueueHost,
  editBannerHost,
  latestTurnId,
  latestTurnStatus,
  latestTurnAuthoritative = true,
  compactOnReturn = null,
  compacting = false,
  awaitingInput = false,
  onSendQueued,
  onQueueCommand,
  queueEdit,
  onReleaseAttachment,
  onSubmit,
  onStop,
  onFocusInput,
}: {
  conversationId: string;
  primaryAction: ComposerPrimaryActionState;
  canSendQueuedNow: boolean;
  running: boolean;
  canSteer?: boolean;
  canInterrupt?: boolean;
  providerSwitchWaitsForTurn?: boolean;
  hasPendingQuestionOrApproval?: boolean;
  resuming?: boolean;
  onResume?: () => Promise<unknown>;
  providers?: readonly ProviderInfo[];
  queueHost?: HTMLElement | null;
  editBannerHost?: HTMLElement | null;
  latestTurnId: string | null;
  latestTurnStatus: AgentTurnStatus | null;
  latestTurnAuthoritative?: boolean;
  compactOnReturn?: ComposerCompactOnReturnAction | null;
  compacting?: boolean;
  awaitingInput?: boolean;
  onSendQueued: (
    content: string,
    attachments: ChatAttachment[],
  ) => Promise<unknown>;
  onQueueCommand?: QueueCommandRunner;
  queueEdit?: QueuedMessageEdit;
  onReleaseAttachment: (attachmentId: string) => Promise<void>;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
  onFocusInput?: () => void;
}): React.JSX.Element {
  const [fallbackQueueHost, setFallbackQueueHost] = useState<HTMLElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (explicitQueueHost !== undefined) return;
    const composer = primaryRef.current?.closest<HTMLElement>(".composer");
    const slot = composer?.querySelector<HTMLElement>(":scope > .composer-queue-slot") ?? null;
    setFallbackQueueHost(slot ?? composer ?? null);
  }, [conversationId, explicitQueueHost]);
  const queueHost = explicitQueueHost !== undefined ? explicitQueueHost : fallbackQueueHost;
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
  const presentation = primaryPresentation(primaryAction, compactOnReturn, compacting, awaitingInput);
  const showsToggle = compactOnReturn !== null && compactOnReturn.toggleVisible && primaryAction === "send-ready";
  const resting = "resting" in presentation && presentation.resting;
  const isStopButton = presentation.action === "stop" || presentation.action === "stop-and-send";
  return (
    <>
      <Suspense fallback={null}>
        <ComposerQueuedActions
          conversationId={conversationId}
          canSendQueuedNow={canSendQueuedNow}
          running={running}
          canSteer={canSteer}
          canInterrupt={canInterrupt}
          providerSwitchWaitsForTurn={providerSwitchWaitsForTurn}
          hasPendingQuestionOrApproval={hasPendingQuestionOrApproval}
          resuming={resuming}
          onResume={onResume}
          providers={providers}
          latestTurnId={latestTurnId}
          latestTurnStatus={latestTurnStatus}
          latestTurnAuthoritative={latestTurnAuthoritative}
          queueHost={queueHost}
          editBannerHost={editBannerHost}
          onSendQueued={onSendQueued}
          onQueueCommand={onQueueCommand}
          queueEdit={queueEdit}
          onFocusInput={onFocusInput}
          onReleaseAttachment={onReleaseAttachment}
        />
      </Suspense>
      {showsToggle && <FullHistoryToggle action={compactOnReturn} />}
      <TooltipButton
        ref={primaryRef}
        tooltip={"tooltip" in presentation && presentation.tooltip ? presentation.tooltip : presentation.label}
        aria-label={presentation.label}
        className={`icon-button send-button${
          isStopButton ? " stop-button" : ""
        }${presentation.iconState === "sending" ? " send-button-loading" : ""}${
          "visibleLabel" in presentation && presentation.visibleLabel ? " has-label" : ""
        }`}
        data-composer-action-state={primaryAction}
        data-motion-state={presentation.iconState}
        aria-busy={presentation.busy}
        aria-disabled={resting || undefined}
        onClick={() => {
          if (presentation.action === "stop") void onStop();
          else if (presentation.action === "resume") void onResume?.();
          else if (resting) onFocusInput?.();
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
        {"visibleLabel" in presentation && presentation.visibleLabel && (
          <span className="send-button-label" aria-hidden="true">{presentation.label}</span>
        )}
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
