import type { ChatMessage } from "@shared/contracts";

export function MessageOrigin({ message }: { message: ChatMessage }) {
  if (message.role !== "user" || !message.privateConnectDeviceId) return null;
  return <span title={`Private Connect device ${message.privateConnectDeviceId}`}>
    Private Connect · {message.privateConnectDeviceId.slice(0, 8)}
  </span>;
}
