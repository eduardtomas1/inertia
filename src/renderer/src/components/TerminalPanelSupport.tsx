import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, MessagesSquare } from "lucide-react";
import type {
  ClientCommand,
  ProviderTerminalResumeDescriptor,
  ThemePreference,
} from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { ProviderResumePicker } from "./ProviderResumePicker";
import type { ProviderTerminalResumeOption } from "./providerResumeOptions";

export const MAX_PERSISTED_TERMINAL_TABS = 4;
export const TERMINAL_CREATE_RETRY_DELAYS_MS = [400, 900] as const;
export const TERMINAL_SETTLING_RETRY_DELAYS_MS = [400, 900, 900] as const;

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

export const command = (value: CommandWithoutId): ClientCommand => ({
  ...value,
  requestId: crypto.randomUUID(),
}) as ClientCommand;

const MAX_TERMINAL_STORAGE_LENGTH = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TerminalTab = {
  id: string;
  label: string;
  terminalId: string | null;
};

export function terminalStorageKey(projectId: string, conversationId?: string): string {
  return `inertia:terminal-sessions:v1:${projectId}:${conversationId ?? "project"}`;
}

export function newTerminalTab(
  index = 0,
  terminalId: string | null = null,
): TerminalTab {
  return {
    id: crypto.randomUUID(),
    label: `Terminal ${index + 1}`,
    terminalId,
  };
}

export function nextTerminalTabIndex(tabs: readonly TerminalTab[]): number {
  const used = new Set(tabs.flatMap(({ label }) => {
    const match = /^Terminal (\d+)$/u.exec(label);
    return match ? [Number(match[1]) - 1] : [];
  }));
  let index = 0;
  while (used.has(index)) index += 1;
  return index;
}

export function readPersistedTerminalTabs(storageKey: string): TerminalTab[] {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw || raw.length > MAX_TERMINAL_STORAGE_LENGTH) return [newTerminalTab()];
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length < 1
      || parsed.length > MAX_PERSISTED_TERMINAL_TABS
      || new Set(parsed.filter((terminalId) => terminalId !== null)).size
        !== parsed.filter((terminalId) => terminalId !== null).length
      || parsed.some((terminalId) => (
        terminalId !== null
        && (typeof terminalId !== "string" || !UUID_PATTERN.test(terminalId))
      ))
    ) return [newTerminalTab()];
    return parsed.map((terminalId, index) => newTerminalTab(index, terminalId));
  } catch {
    return [newTerminalTab()];
  }
}

export function waitForTerminalRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function terminalTheme(_theme: ThemePreference): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-fg").trim(),
    cursor: styles.getPropertyValue("--accent").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}

type TerminalResumeStatusProps = {
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
