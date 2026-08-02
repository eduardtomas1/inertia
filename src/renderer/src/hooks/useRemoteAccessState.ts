import { useCallback, useEffect, useState } from "react";

import type { RemoteAccessState } from "@shared/remote-protocol";

export type RemoteAccessLoadState =
  | { status: "loading"; state: null; error: null; retry: () => void }
  | { status: "ready"; state: RemoteAccessState; error: null; retry: () => void }
  | { status: "error"; state: null; error: string; retry: () => void };

export function useRemoteAccessState(): RemoteAccessLoadState {
  const [generation, setGeneration] = useState(0);
  const [result, setResult] = useState<
    Omit<RemoteAccessLoadState, "retry">
  >({ status: "loading", state: null, error: null });
  const retry = useCallback(() => {
    setResult({ status: "loading", state: null, error: null });
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const bridge = window.inertia;
    if (
      typeof bridge?.getRemoteAccessState !== "function"
      || typeof bridge.onRemoteAccessState !== "function"
    ) {
      setResult({
        status: "error",
        state: null,
        error: "Remote Companion is unavailable in this window.",
      });
      return;
    }
    let active = true;
    let live = false;
    const unsubscribe = bridge.onRemoteAccessState((value) => {
      if (!active) return;
      live = true;
      setResult({ status: "ready", state: value, error: null });
    });
    void bridge.getRemoteAccessState().then((value) => {
      if (active && !live) {
        setResult({ status: "ready", state: value, error: null });
      }
    }).catch((error: unknown) => {
      if (!active || live) return;
      setResult({
        status: "error",
        state: null,
        error: error instanceof Error && error.message.trim()
          ? error.message
          : "Remote Companion state could not be loaded.",
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [generation]);

  return { ...result, retry } as RemoteAccessLoadState;
}
