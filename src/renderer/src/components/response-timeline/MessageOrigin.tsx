import type { ChatMessage } from "@shared/contracts";
import { watcherPresetName } from "../../utils/watcherLinks";
import { TooltipText } from "../TooltipText";

export function MessageOrigin({ message }: { message: ChatMessage }) {
  if (message.role !== "user") return null;
  if (message.watcherNote) {
    const note = message.watcherNote;
    return <TooltipText className="message-watcher-origin" tooltip={`Forwarded by the watcher (${note.watcherLabel}) when you chose Send`}>
      Note from watcher · {watcherPresetName(note.preset)}
    </TooltipText>;
  }
  if (!message.privateConnectDeviceId) return null;
  return <TooltipText tooltip={`Private Connect device ${message.privateConnectDeviceId}`}>
    Private Connect · {message.privateConnectDeviceId.slice(0, 8)}
  </TooltipText>;
}
