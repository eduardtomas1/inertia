import { useCallback, useEffect, useRef, useState } from "react";
import type { CursorSdkLoginState, CursorSdkStatusResult } from "@shared/cursor-sdk-auth";
import { isCursorSdkLoginUrl } from "@shared/cursor-sdk-auth";
import type { CursorSdkTransport } from "./CursorSdkContext";

export function useCursorSdkAccount({ status, sendCommand, subscribe }: CursorSdkTransport) {
  const [evidence, setEvidence] = useState<CursorSdkStatusResult | null>(null);
  const [login, setLogin] = useState<CursorSdkLoginState | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<string | null>(null);
  const probe = useRef<string | null>(null);
  const cancelling = useRef(false);
  const online = status === "online";

  const check = useCallback(async (refreshModels = false) => {
    if (!online || attempt.current || probe.current) return;
    const requestId = crypto.randomUUID();
    probe.current = requestId;
    setChecking(true);
    setEvidence(null);
    setError(null);
    try {
      const event = await sendCommand({ type: "provider.cursor-sdk.status", requestId });
      if (probe.current !== requestId) return;
      if (event.type !== "request.result" || event.requestId !== requestId
        || event.result.kind !== "provider.cursor-sdk.status") throw new Error();
      setEvidence(event.result);
      if (refreshModels && event.result.available && event.result.hasCredential) {
        const modelsRequestId = crypto.randomUUID();
        const models = await sendCommand({ type: "provider.cursor-sdk.models", requestId: modelsRequestId });
        if (models.type !== "request.result" || models.requestId !== modelsRequestId
          || models.result.kind !== "provider.cursor-sdk.models") throw new Error();
      }
    } catch {
      if (probe.current === requestId) setError("Could not check Cursor SDK. Try again.");
    } finally {
      if (probe.current === requestId) {
        probe.current = null;
        setChecking(false);
      }
    }
  }, [online, sendCommand]);

  const cancel = useCallback(() => {
    const loginRequestId = attempt.current;
    if (!loginRequestId) return;
    cancelling.current = true;
    setLogin({ status: "cancelling" });
    void sendCommand({
      type: "provider.cursor-sdk.login.cancel",
      requestId: crypto.randomUUID(),
      payload: { loginRequestId },
    }).then((event) => {
      if (event.type !== "request.ok") throw new Error();
    }).catch(() => {
      if (attempt.current === loginRequestId) setError("Cancellation could not be confirmed. Retry cancellation.");
    });
  }, [sendCommand]);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      if (event.type !== "provider.cursor-sdk.login.updated"
        || event.loginRequestId !== attempt.current) return;
      if (cancelling.current && ["starting", "waiting"].includes(event.status)) return;
      if (event.status === "waiting" && !isCursorSdkLoginUrl(event.loginUrl)) {
        setError("Cursor returned an invalid sign-in link.");
        cancel();
        return;
      }
      setLogin(event);
      if (["authenticated", "cancelled", "expired", "failed"].includes(event.status)) {
        attempt.current = null;
        if (event.status === "authenticated") void check(true);
      }
    });
    return () => {
      unsubscribe();
      const loginRequestId = attempt.current;
      attempt.current = null;
      probe.current = null;
      if (loginRequestId) {
        void sendCommand({
          type: "provider.cursor-sdk.login.cancel",
          requestId: crypto.randomUUID(),
          payload: { loginRequestId },
        }).catch(() => undefined);
      }
    };
  }, [cancel, check, sendCommand, subscribe]);

  useEffect(() => {
    if (online) return;
    attempt.current = null;
    probe.current = null;
    setChecking(false);
    setEvidence(null);
    setLogin(null);
    setError("Disconnected. Reconnect, then check Cursor SDK to continue.");
  }, [online]);

  const start = () => {
    if (!online || !evidence?.available || attempt.current || probe.current) return;
    const requestId = crypto.randomUUID();
    attempt.current = requestId;
    cancelling.current = false;
    setLogin({ status: "starting" });
    setError(null);
    setEvidence(null);
    void sendCommand({ type: "provider.cursor-sdk.login", requestId }).then((event) => {
      if (attempt.current !== requestId) return;
      if (event.type !== "request.ok" || event.requestId !== requestId) throw new Error();
    }).catch(() => {
      if (attempt.current !== requestId) return;
      attempt.current = null;
      setLogin({ status: "failed" });
    });
  };

  const openBrowser = async () => {
    if (!online || login?.status !== "waiting" || !attempt.current
      || !isCursorSdkLoginUrl(login.loginUrl)) return;
    try {
      await window.inertia.openExternal(login.loginUrl);
    } catch {
      setError("Could not open the browser. Try again.");
    }
  };

  return { evidence, login, checking, error, online, check, start, cancel, openBrowser };
}
