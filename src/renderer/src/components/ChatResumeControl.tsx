import { useEffect, useRef } from "react";

import type { ProviderTerminalResumeOption } from "./providerResumeOptions";
import { ProviderResumePicker } from "./ProviderResumePicker";
import "./composer/ComposerCommandMenu.css";

export interface ChatResumeControlProps {
  options: readonly ProviderTerminalResumeOption[];
  busy?: boolean;
  onResume: (conversationId: string) => void;
}

export interface ChatResumeInlineProps extends ChatResumeControlProps {
  open: boolean;
  onDismiss: (reason: "action" | "escape" | "outside") => void;
}

export function ChatResumeControl({
  options,
  busy = false,
  open,
  onDismiss,
  onResume,
}: ChatResumeInlineProps): React.JSX.Element | null {
  const surfaceRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onDismiss("escape");
    };
    const dismissOnPointerDown = (event: PointerEvent): void => {
      if (surfaceRef.current?.contains(event.target as Node)) return;
      onDismiss("outside");
    };
    document.addEventListener("keydown", dismissOnEscape);
    document.addEventListener("pointerdown", dismissOnPointerDown);
    return () => {
      document.removeEventListener("keydown", dismissOnEscape);
      document.removeEventListener("pointerdown", dismissOnPointerDown);
    };
  }, [onDismiss, open]);

  if (!open) return null;

  return (
    <div className="composer-command-layer is-resume-layer">
      <div
        ref={surfaceRef}
        className="composer-command-menu composer-resume-menu"
        role="region"
        aria-label="Resume a provider chat"
        aria-busy={busy}
      >
        <div className="composer-command-group-label">Provider chats</div>
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
