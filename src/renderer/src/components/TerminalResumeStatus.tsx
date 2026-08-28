import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, MessagesSquare } from "lucide-react";
import type { ProviderTerminalResumeDescriptor } from "@shared/contracts";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { ProviderResumePicker } from "./ProviderResumePicker";
import type { ProviderTerminalResumeOption } from "./providerResumeOptions";

export type TerminalResumeStatusProps = {
  selectedResumeOption: ProviderTerminalResumeOption;
  resumeOptions: readonly ProviderTerminalResumeOption[];
  activeResume: ProviderTerminalResumeDescriptor | null;
  siblingResumedConversationIds: ReadonlySet<string>;
  resumeBlockedBySibling: boolean;
  resumeInFlight: boolean;
  sessionState: "starting" | "ready" | "closed" | "error";
  status: ConnectionStatus;
  projectName: string;
  resumeError: string | null;
  onSelect: (conversationId: string) => void;
  onResume: () => boolean;
};

export function TerminalResumeStatus({
  selectedResumeOption,
  resumeOptions,
  activeResume,
  siblingResumedConversationIds,
  resumeBlockedBySibling,
  resumeInFlight,
  sessionState,
  status,
  projectName,
  resumeError,
  onSelect,
  onResume,
}: TerminalResumeStatusProps): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();
  const availability = selectedResumeOption.availability;
  const displayedResume = activeResume ?? availability.resume;

  useEffect(() => {
    if (!pickerOpen) return;
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      const anchor = pickerRef.current;
      if (!anchor || anchor.contains(event.target as Node)) return;
      setPickerOpen(false);
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", dismissOnOutsidePointer);
  }, [pickerOpen]);

  const closePicker = (): void => {
    setPickerOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div
      className={`terminal-resume-status is-${availability.kind}`}
      role={resumeError ? "alert" : "status"}
    >
      <MessagesSquare size={14} />
      <span id={descriptionId}>
        {resumeOptions.length > 1 && (
          <span className="terminal-resume-picker">
            <span className="terminal-resume-picker-caption">Resume provider chat</span>
            <span ref={pickerRef} className={`terminal-resume-anchor${pickerOpen ? " is-open" : ""}`}>
              <button
                ref={triggerRef}
                type="button"
                className="terminal-resume-trigger"
                aria-label={`Chat to resume: ${selectedResumeOption.conversationTitle} in ${selectedResumeOption.projectName}`}
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                disabled={Boolean(activeResume) || resumeInFlight}
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span className="terminal-resume-trigger-copy">
                  <strong>{selectedResumeOption.conversationTitle}</strong>
                  <small>{selectedResumeOption.projectName}</small>
                </span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {pickerOpen && (
                <span className="terminal-resume-popover" role="dialog" aria-label="Choose a chat to resume">
                  <ProviderResumePicker
                    options={resumeOptions}
                    selectedConversationId={selectedResumeOption.conversationId}
                    blockedConversationIds={siblingResumedConversationIds}
                    autoFocus
                    onSelect={(conversationId) => {
                      onSelect(conversationId);
                      closePicker();
                    }}
                    onCancel={closePicker}
                  />
                </span>
              )}
            </span>
          </span>
        )}
        {displayedResume ? (
          <>
            <span>{displayedResume.providerLabel} session</span>
            <code title={displayedResume.sessionId}>{displayedResume.sessionId}</code>
          </>
        ) : (
          <span>{availability.reason}</span>
        )}
        {availability.resume && availability.kind === "unavailable" && <small>{availability.reason}</small>}
        {activeResume && <small>End this terminal session before sending another message in Inertia.</small>}
        {resumeBlockedBySibling && <small>This provider session is already resumed in another terminal tab.</small>}
        {resumeError && <small>{resumeError}</small>}
      </span>
      {availability.kind === "available" && (
        <button
          type="button"
          className="secondary-button"
          aria-label={activeResume
            ? `${activeResume.providerLabel} session is resumed in ${projectName}`
            : resumeBlockedBySibling
              ? `${availability.resume.providerLabel} session is resumed in another ${projectName} terminal`
              : resumeOptions.length === 1
                ? `Resume ${availability.resume.providerLabel} session in ${selectedResumeOption.projectName}`
                : `Resume ${availability.resume.providerLabel} chat ${selectedResumeOption.conversationTitle} in ${selectedResumeOption.projectName}`}
          aria-describedby={descriptionId}
          disabled={Boolean(activeResume) || resumeBlockedBySibling || resumeInFlight || sessionState !== "ready" || status !== "online"}
          onClick={onResume}
        >
          {activeResume ? "Resumed" : resumeBlockedBySibling ? "Resumed elsewhere" : resumeInFlight ? "Resuming…" : "Resume chat"}
        </button>
      )}
    </div>
  );
}
