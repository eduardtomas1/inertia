import { useEffect, useState } from "react";

import type { RemoteAccessState } from "@shared/remote-protocol";

export function useRemoteAccessState(): RemoteAccessState | null {
  const [state, setState] = useState<RemoteAccessState | null>(null);

  useEffect(() => {
    const bridge = window.inertia;
    if (
      typeof bridge?.getRemoteAccessState !== "function"
      || typeof bridge.onRemoteAccessState !== "function"
    ) return;
    let active = true;
    let live = false;
    const unsubscribe = bridge.onRemoteAccessState((value) => {
      if (!active) return;
      live = true;
      setState(value);
    });
    void bridge.getRemoteAccessState().then((value) => {
      if (active && !live) setState(value);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}
