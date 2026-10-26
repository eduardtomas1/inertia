import { useEffect, useState } from "react";
import { claimFreshRequest, isFreshRequest } from "../../utils/requestLiftOff";

export function useFreshRequest(conversationId: string, content: string): boolean {
  const [fresh] = useState(() => isFreshRequest(conversationId, content));
  useEffect(() => {
    if (fresh) claimFreshRequest(conversationId, content);
  }, [content, conversationId, fresh]);
  return fresh;
}
