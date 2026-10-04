import { useEffect, useRef, useState } from "react";
import type { SnapshotRequest, SnapshotState } from "@shared/snapshots";

export interface SnapshotSettingsState {
  available: boolean;
  state: SnapshotState | null;
  error: string | null;
  pending: boolean;
  linux: boolean;
  accelerator: string;
  request: (input: SnapshotRequest) => Promise<void>;
  configure: (input: SnapshotRequest) => Promise<void>;
}

export function useSnapshotSettings(): SnapshotSettingsState {
  const [state, setState] = useState<SnapshotState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const revision = useRef(0);
  const configuring = useRef(false);
  const linux = navigator.platform.toLowerCase().includes("linux");
  const accelerator = navigator.platform.includes("Mac") ? "⌘⌥S" : "Ctrl+Alt+S";

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      if (configuring.current || !window.inertia?.snapshot) return;
      const requested = ++revision.current;
      void window.inertia.snapshot({ type: "state" }).then((value) => {
        if (active && revision.current === requested) { setState(value); setError(null); }
      }).catch(() => {
        if (active && revision.current === requested) setError("Could not load Snapshots settings. Reopen this page to try again.");
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { active = false; revision.current += 1; window.removeEventListener("focus", refresh); };
  }, []);

  const configure = async (input: SnapshotRequest): Promise<void> => {
    const requested = ++revision.current;
    configuring.current = true;
    setPending(true); setError(null);
    try {
      const value = await window.inertia.snapshot(input);
      if (revision.current === requested) setState(value);
    } catch (cause) {
      const value = await window.inertia.snapshot({ type: "state" }).catch(() => null);
      if (value && revision.current === requested) setState(value);
      throw new Error(cause instanceof Error ? cause.message : "Snapshots unavailable.", { cause });
    } finally {
      configuring.current = false;
      if (revision.current === requested) setPending(false);
    }
  };

  const request = async (input: SnapshotRequest): Promise<void> => {
    await configure(input).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Snapshots unavailable."));
  };

  return { available: Boolean(window.inertia?.snapshot), state, error, pending, linux, accelerator, request, configure };
}
