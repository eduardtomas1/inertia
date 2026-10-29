import { createContext } from "react";
import type { SecretRequestCommandRunner } from "../../utils/response-timeline/secretRequests";

export interface SecretRequestContextValue {
  conversationId: string;
  onCommand?: SecretRequestCommandRunner;
}

export const SecretRequestContext = createContext<SecretRequestContextValue>({ conversationId: "" });

const autoFocusedRequests = new Set<string>();

export function claimSecretRequestAutoFocus(requestId: string): boolean {
  if (autoFocusedRequests.has(requestId)) return false;
  autoFocusedRequests.add(requestId);
  if (autoFocusedRequests.size > 200) {
    const oldest = autoFocusedRequests.values().next().value;
    if (oldest !== undefined) autoFocusedRequests.delete(oldest);
  }
  return true;
}
