import { ChevronDown } from "lucide-react";

import type { WatcherDeliveryMode } from "@shared/watcher";
import { WatcherMenu } from "./WatcherMenu";

/**
 * Split button: Send queues the note for the main chat's next turn (or starts
 * it when the chat is idle). The menu repeats that choice explicitly and adds
 * Steer now only while the watched turn runs on a steerable harness.
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
  return (
    <div className="watcher-deliver" role="group" aria-label="Send to the main chat">
      <button
        type="button"
        className="primary-button watcher-deliver-send"
        disabled={disabled}
        onClick={() => onDeliver("queue")}
      >
        Send
      </button>
      <WatcherMenu
        label="More ways to send"
        trigger={<ChevronDown size={14} aria-hidden="true" />}
        triggerClassName="primary-button watcher-deliver-more"
        menuClassName="watcher-deliver-menu"
        disabled={disabled}
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
              <span>
                <strong>Queue for next turn</strong>
                <small>Waits for the current turn to finish</small>
              </span>
            </button>
            {steerable && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  close(false);
                  onDeliver("steer");
                }}
              >
                <span>
                  <strong>Steer now</strong>
                  <small>Delivers the note into the running turn</small>
                </span>
              </button>
            )}
          </>
        )}
      </WatcherMenu>
    </div>
  );
}
