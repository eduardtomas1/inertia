import type { ChatMessage } from "@shared/contracts";
import { watcherPresetName } from "../../utils/watcherLinks";
import { TooltipText } from "../TooltipText";

export function MessageOrigin({ message }: { message: ChatMessage }) {
  if (message.role !== "user") return null;
  if (message.watcherNote) {
    const note = message.watcherNote;
    const source = `${watcherPresetName(note.preset)} · ${note.watcherLabel}`;
    const automatic = note.automatic === true;
    return <TooltipText className="message-watcher-origin" tooltip={automatic
      ? `Sent automatically by the watcher (${source})`
      : `Forwarded by the watcher (${source}) when you chose Send`}>
      From watcher
    </TooltipText>;
  }
  if (!message.privateConnectDeviceId) return null;
  return <TooltipText tooltip={`Private Connect device ${message.privateConnectDeviceId}`}>
    Private Connect · {message.privateConnectDeviceId.slice(0, 8)}
  </TooltipText>;
}
