import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseAppControlSettingsState,
  type AppControlSettingsRequest,
  type AppControlSettingsState,
} from "@shared/app-control-settings";

export interface AppControlSettingsModel {
  /** False outside the desktop app. */
  available: boolean;
  state: AppControlSettingsState | null;
  error: string | null;
  pending: boolean;
  openPane: (pane: Extract<AppControlSettingsRequest, { type: "open-settings" }>["pane"]) => void;
}

const LOAD_FAILED = "Could not read App control access. Reopen this page to try again.";

/** Reads main's App control state on mount and whenever the window regains focus. */
export function useAppControlSettings(): AppControlSettingsModel {
  const [state, setState] = useState<AppControlSettingsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const bridge = typeof window === "undefined" ? undefined : window.inertia?.appControl;

  const send = useCallback(async (request: AppControlSettingsRequest): Promise<void> => {
    if (!window.inertia?.appControl) return;
    const requested = ++revision.current;
    try {
      const value = parseAppControlSettingsState(await window.inertia.appControl(request));
      if (!mounted.current || revision.current !== requested) return;
      if (!value) throw new Error("invalid");
      setState(value);
      setError(null);
    } catch {
      if (mounted.current && revision.current === requested) setError(LOAD_FAILED);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = (): void => { void send({ type: "state" }); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      revision.current += 1;
      window.removeEventListener("focus", refresh);
    };
  }, [send]);

  const openPane = useCallback((pane: Extract<AppControlSettingsRequest, { type: "open-settings" }>["pane"]): void => {
    if (pending) return;
    setPending(true);
    void send({ type: "open-settings", pane }).finally(() => {
      if (mounted.current) setPending(false);
    });
  }, [pending, send]);

  return { available: Boolean(bridge), state, error, pending, openPane };
}
