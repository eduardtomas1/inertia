import { useCallback, useEffect, useState } from "react";
import type { PrivateConnectStateView } from "@shared/private-connect/protocol";

export function usePrivateConnectState(): {
  state: PrivateConnectStateView | null;
  error: string | null;
  retry: () => void;
} {
  const [state, setState] = useState<PrivateConnectStateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const retry = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    if (!window.inertia?.getPrivateConnectState || !window.inertia?.onPrivateConnectState) {
      setError("Private Connect is unavailable in this window.");
      return () => { active = false; };
    }
    const unsubscribe = window.inertia.onPrivateConnectState((next) => {
      if (active) { setState(next); setError(null); }
    });
    void window.inertia.getPrivateConnectState().then((next) => {
      if (active) { setState(next); setError(null); }
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Private Connect state could not be loaded.");
    });
    return () => { active = false; unsubscribe(); };
  }, [version]);
  return { state, error, retry };
}
