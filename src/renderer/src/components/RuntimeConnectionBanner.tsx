import { useEffect, useState } from "react";

import type { InertiaConnection } from "../hooks/useInertiaConnection";
import "./RuntimeConnectionBanner.css";

export const RUNTIME_RECONNECTING_NOTICE_DELAY_MS = 1_500;

export function connectionToastError(
  connection: Pick<InertiaConnection, "status" | "snapshot" | "runtimeStopped" | "error">,
): string | null {
  const { status, snapshot, runtimeStopped, error } = connection;
  if (runtimeStopped) return error === runtimeStopped.message ? null : error;
  return snapshot !== null && status !== "online" ? null : error;
}

async function restartAndKeepFocus(restartRuntime: () => Promise<void>): Promise<void> {
  await restartRuntime();
  if (document.activeElement && document.activeElement !== document.body) return;
  document.querySelector<HTMLTextAreaElement>(".composer-input-zone textarea")
    ?.focus({ preventScroll: true });
}

export function RuntimeConnectionBanner({
  connection,
}: {
  connection: Pick<InertiaConnection, "status" | "snapshot" | "runtimeStopped" | "restartRuntime">;
}): React.JSX.Element | null {
  const { status, snapshot, runtimeStopped, restartRuntime } = connection;
  const reconnecting = runtimeStopped === null && status !== "online" && snapshot !== null;
  const [reconnectingNoticed, setReconnectingNoticed] = useState(false);
  useEffect(() => {
    if (!reconnecting) {
      setReconnectingNoticed(false);
      return;
    }
    const timer = window.setTimeout(() => setReconnectingNoticed(true), RUNTIME_RECONNECTING_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [reconnecting]);

  if (status === "online" || (!runtimeStopped && !(reconnecting && reconnectingNoticed))) return null;
  return (
    <div
      className="runtime-connection-banner"
      role="status"
      aria-live="polite"
      data-connection-status={status}
    >
      <span>
        {!runtimeStopped
          ? "Reconnecting to the local service…"
          : runtimeStopped.restartable ? "The local service stopped." : runtimeStopped.message}
      </span>
      {runtimeStopped?.restartable && (
        <button type="button" className="text-button" onClick={() => void restartAndKeepFocus(restartRuntime)}>
          Restart
        </button>
      )}
    </div>
  );
}
