import { useState } from "react";
import { InertiaMorphIcon } from "../motion/InertiaMorphIcon";
import {
  checkMorphIcon,
  loaderCircleMorphIcon,
  sendHorizontalMorphIcon,
  sendMorphIcon,
  squareMorphIcon,
} from "../motion/lucideMorphData";
import type {
  ComposerFollowUpState,
  ComposerPrimaryActionState,
} from "../../utils/composerPrimaryAction";
import type { MessageSendAcceptance } from "@shared/contracts";
import {
  type ComposerSendFeedback,
  useComposerSendFeedback,
} from "./useComposerSendFeedback";
import "./ComposerSendActions.css";

function FollowUpAction({
  state,
  onSubmit,
}: {
  state: ComposerFollowUpState;
  onSubmit: () => Promise<void>;
}): React.JSX.Element | null {
  if (state === "unavailable") {
    return (
      <small
        className="composer-follow-up-unavailable"
        role="status"
        title="This active agent route cannot accept parent follow-ups."
      >
        Follow-up unavailable
      </small>
    );
  }
  if (state !== "ready" && state !== "pending") return null;
  const pending = state === "pending";
  const icon = pending ? loaderCircleMorphIcon : sendMorphIcon;
  const iconState = pending ? "sending" : "send";
  return (
    <button
      type="button"
      className="secondary-button composer-follow-up-button"
      aria-label={pending ? "Sending follow-up" : "Send follow-up"}
      aria-busy={pending}
      disabled={pending}
      data-motion-state={iconState}
      onClick={() => void onSubmit()}
    >
      <InertiaMorphIcon
        className="composer-send-motion-icon"
        icon={icon}
        iconState={iconState}
        size={13}
      />
      <span>{pending ? "Sending…" : "Follow up"}</span>
    </button>
  );
}

function AcceptanceStatus({
  kind,
  visuallyHidden = false,
}: {
  kind: "message" | "follow-up";
  visuallyHidden?: boolean;
}): React.JSX.Element {
  const label = kind === "follow-up" ? "Follow-up accepted." : "Message accepted.";
  return (
    <span
      className={visuallyHidden
        ? "composer-send-acceptance visually-hidden"
        : "composer-send-acceptance"}
      data-motion-state="accepted"
      role="status"
      aria-live="polite"
    >
      <InertiaMorphIcon icon={checkMorphIcon} iconState="accepted" size={13} />
      <span className="composer-send-acceptance-text" aria-hidden="true">
        Accepted
      </span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

function primaryPresentation(
  state: ComposerPrimaryActionState,
  accepted: boolean,
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
    return accepted
      ? {
          action: "send" as const,
          busy: false,
          disabled: true,
          icon: checkMorphIcon,
          iconState: "accepted",
          label: "Message accepted",
        }
      : {
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
  followUpState,
  primaryAction,
  feedback,
  onSubmit,
  onStop,
}: {
  followUpState: ComposerFollowUpState;
  primaryAction: ComposerPrimaryActionState;
  feedback: ComposerSendFeedback | null;
  onSubmit: () => Promise<void>;
  onStop: () => Promise<void>;
}): React.JSX.Element {
  const [intent, setIntent] = useState(false);
  const followUpAccepted = feedback?.disposition === "follow-up";
  const primaryAccepted = primaryAction === "submitting"
    && feedback?.disposition === "new-turn";
  const showFollowUpStatus = followUpAccepted
    && feedback.visible
    && followUpState !== "ready"
    && followUpState !== "pending";
  const showPrimaryStatus = feedback?.disposition === "new-turn"
    && feedback.visible;
  const presentation = primaryPresentation(primaryAction, primaryAccepted, intent);
  return (
    <>
      {showFollowUpStatus ? (
        <AcceptanceStatus kind="follow-up" />
      ) : (
        <FollowUpAction state={followUpState} onSubmit={onSubmit} />
      )}
      {showPrimaryStatus ? (
        <AcceptanceStatus kind="message" visuallyHidden={primaryAccepted} />
      ) : null}
      <button
        type="button"
        aria-label={presentation.label}
        title={presentation.label}
        className={`icon-button send-button${
          presentation.action === "stop" ? " stop-button" : ""
        }${presentation.iconState === "sending" ? " send-button-loading" : ""}${
          presentation.iconState === "accepted" ? " send-button-accepted" : ""
        }`}
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
  acceptance,
  ...props
}: Omit<React.ComponentProps<typeof ComposerSendActions>, "feedback"> & {
  conversationId: string;
  acceptance: MessageSendAcceptance | null;
}): React.JSX.Element {
  const feedback = useComposerSendFeedback(conversationId, acceptance);
  return <ComposerSendActions {...props} feedback={feedback} />;
}
