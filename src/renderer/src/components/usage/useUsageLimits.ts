import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ServerEvent } from "@shared/contracts";
import type { UsageAccount, UsageLimitsSnapshot } from "@shared/provider-usage-limits";

import type { ConnectionStatus } from "../../hooks/useInertiaConnection";
import { resultEvent, type CommandWithoutId } from "../../lib/runtimeCommands";
import { useUsageLimitsContext } from "../usage-limits-state";

const LIMITS_POLL_MS = 600;
const STALE_AFTER_MS = 180_000;
const TICK_MS = 60_000;
const REFRESH_EVERY_TICKS = 3;
const NO_PENDING: ReadonlySet<string> = new Set();

interface UsageLimitsState {
  snapshot: UsageLimitsSnapshot | null;
  accounts: UsageAccount[];
  busy: boolean;
  pending: ReadonlySet<string>;
  error: string | null;
  now: number;
  refresh(): void;
}

export function useUsageLimits(
  request: (command: CommandWithoutId) => Promise<ServerEvent>,
  status: ConnectionStatus,
): UsageLimitsState {
  const context = useUsageLimitsContext();
  const publish = context?.setSnapshot;
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(context?.snapshot ?? null);
  const [running, setRunning] = useState<{ since: number; quiet: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const loading = useRef(false);
  const forceNext = useRef(false);
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const shown = useRef(snapshot);
  const accept = useCallback((next: UsageLimitsSnapshot): void => {
    shown.current = next;
    setSnapshot(next);
    publish?.(next);
    setNow(Date.now());
  }, [publish]);
  const load = useCallback(async (force = false, background = false): Promise<void> => {
    if (status !== "online") return;
    if (loading.current) {
      forceNext.current ||= force;
      return;
    }
    loading.current = true;
    setRunning({ since: Date.now(), quiet: background });
    setError(null);
    const peek = async (): Promise<void> => {
      try {
        const result = resultEvent(await request({ type: "usage.limits.get", payload: { refresh: false, force: false } })).result;
        if (result.kind === "usage.limits" && alive.current && loading.current) accept(result.snapshot);
      } catch {
        return;
      }
    };
    if (!shown.current) void peek();
    clearInterval(poll.current);
    poll.current = setInterval(() => void peek(), LIMITS_POLL_MS);
    const timer = poll.current;
    try {
      const result = resultEvent(await request({
        type: "usage.limits.get",
        payload: { refresh: true, force, ...(background ? { background } : {}) },
      })).result;
      if (result.kind !== "usage.limits") throw new Error();
      loading.current = false;
      if (alive.current) accept(result.snapshot);
    } catch {
      if (alive.current) setError("Refresh failed. Previously reported limits may be stale.");
    } finally {
      clearInterval(timer);
      loading.current = false;
      if (alive.current) setRunning(null);
    }
    if (forceNext.current && alive.current) {
      forceNext.current = false;
      await load(true);
    }
  }, [accept, request, status]);
  useEffect(() => {
    alive.current = true;
    if (document.visibilityState !== "hidden") void load();
    let timer: ReturnType<typeof setInterval> | undefined;
    let ticks = 0;
    const visibility = (): void => {
      if (timer) clearInterval(timer);
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      if (Date.now() - Date.parse(shown.current?.checkedAt ?? "") > STALE_AFTER_MS) void load(false, true);
      timer = setInterval(() => {
        setNow(Date.now());
        ticks += 1;
        if (ticks % REFRESH_EVERY_TICKS === 0) void load(false, true);
      }, TICK_MS);
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      alive.current = false;
      clearInterval(poll.current);
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load]);
  const failed = error !== null;
  const accounts = useMemo(() => (snapshot?.accounts ?? []).map((account): UsageAccount => (
    account.status === "ready" && (
      failed
      || status !== "online"
      || now - Date.parse(account.updatedAt ?? "") > STALE_AFTER_MS
      || account.windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now)
    ) ? { ...account, status: "stale", canReset: false } : account
  )), [failed, now, snapshot, status]);
  const pending = useMemo(() => running === null || running.quiet
    ? NO_PENDING
    : new Set((snapshot?.accounts ?? [])
      .filter((account) => !(Date.parse(account.checkedAt ?? "") >= running.since))
      .map(({ id }) => id)), [running, snapshot]);
  const refresh = useCallback((): void => { void load(true); }, [load]);
  return { snapshot, accounts, busy: running !== null, pending, error, now, refresh };
}
