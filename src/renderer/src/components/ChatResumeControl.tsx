import { useEffect } from "react";
import { MessagesSquare, X } from "lucide-react";

import type { ProviderTerminalResumeOption } from "./providerResumeOptions";
import { ProviderResumePicker } from "./ProviderResumePicker";
import { IconButton } from "./ui";

export interface ChatResumeControlProps {
  options: readonly ProviderTerminalResumeOption[];
  busy?: boolean;
  onResume: (conversationId: string) => void;
}

export interface ChatResumeInlineProps extends ChatResumeControlProps {
  open: boolean;
  onDismiss: (reason: "action" | "escape") => void;
}

export function ChatResumeControl({
  options,
  busy = false,
  open,
  onDismiss,
  onResume,
}: ChatResumeInlineProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss("escape");
    };
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [onDismiss, open]);

  if (!open) return null;

  return (
    <div className="chat-command-surface is-command-surface">
      <div
        className="chat-command-inline"
        role="region"
        aria-label="Resume a provider chat"
        aria-busy={busy}
      >
        <header>
          <span>
            <MessagesSquare size={15} aria-hidden="true" />
            <span>
              <strong>Resume a provider chat</strong>
              <small>
                Reattach a saved provider session in this project&apos;s terminal
              </small>
            </span>
          </span>
          <IconButton
            label="Close resume controls"
            onClick={() => onDismiss("action")}
          >
            <X size={14} />
          </IconButton>
        </header>
        <ProviderResumePicker
          options={options}
          selectedConversationId={null}
          busy={busy}
          autoFocus
          onSelect={(conversationId) => {
            onResume(conversationId);
            onDismiss("action");
          }}
          onCancel={() => onDismiss("escape")}
        />
      </div>
    </div>
  );
}
