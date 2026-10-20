import { ChevronDown } from "lucide-react";

import type { WatcherDeliveryMode } from "@shared/watcher";
import { WatcherMenu } from "./WatcherMenu";

/**
 * Send queues the note for the main chat's next turn, or starts that turn
 * when the chat is idle. Only while the watched turn runs on a steerable
 * harness does it become a split button whose menu adds Steer now; otherwise
 * the menu would repeat Send.
 */
export function WatcherDeliverButton({
  disabled,
  steerable,
  onDeliver,
}: {
  disabled: boolean;
  steerable: boolean;
  onDeliver: (mode: WatcherDeliveryMode) => void;
}): React.JSX.Element {
  const send = (
    <button
      type="button"
      className="watcher-text-button is-primary"
      aria-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onDeliver("queue"); }}
    >
      Send
    </button>
  );
  if (!steerable) return <div className="watcher-deliver is-single">{send}</div>;
  return (
    <div className="watcher-deliver" role="group" aria-label="Send to the main chat">
      {send}
      <WatcherMenu
        label="More ways to send"
        trigger={<ChevronDown size={14} aria-hidden="true" />}
        triggerClassName="watcher-text-button watcher-deliver-more"
        menuClassName="watcher-deliver-menu"
        disabled={disabled}
        floating
      >
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(false);
                onDeliver("queue");
              }}
            >
              Queue for next turn
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                close(false);
                onDeliver("steer");
              }}
            >
              Steer now
            </button>
          </>
        )}
      </WatcherMenu>
    </div>
  );
}
