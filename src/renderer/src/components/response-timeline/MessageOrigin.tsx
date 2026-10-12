import type { ChatMessage } from "@shared/contracts";
import { TooltipText } from "../TooltipText";

export function MessageOrigin({ message }: { message: ChatMessage }) {
  if (message.role !== "user" || !message.privateConnectDeviceId) return null;
  return <TooltipText tooltip={`Private Connect device ${message.privateConnectDeviceId}`}>
    Private Connect · {message.privateConnectDeviceId.slice(0, 8)}
  </TooltipText>;
}
