import { useEffect, useState } from "react";
import { claimFreshRequest, isFreshRequest } from "../../utils/requestLiftOff";

export function useFreshRequest(content: string): boolean {
  const [fresh] = useState(() => isFreshRequest(content));
  useEffect(() => {
    if (fresh) claimFreshRequest(content);
  }, [content, fresh]);
  return fresh;
}
