import { useEffect, useState } from "react";
import { deduplicateUsageAccounts } from "@shared/usage-limits-projection";

import { resultEvent } from "../../lib/runtimeCommands";
import { useUsageLimitsContext } from "../usage-limits-state";
import { ageLabel } from "./limitText";
import "./UsageAccountsHint.css";

export function UsageAccountsHint({ providerId, remaining }: { providerId: string; remaining: number }): React.JSX.Element | null {
  const context = useUsageLimitsContext();
  const snapshot = context?.snapshot ?? null; const request = context?.request; const publish = context?.setSnapshot;
  const online = context?.status === "online";
  const [now] = useState(Date.now);
  useEffect(() => {
    if (snapshot || !request || !online) return;
    let active = true;
    void request({ type: "usage.limits.get", payload: { refresh: false, force: false } }).then((event) => {
      const result = resultEvent(event).result;
      if (active && result.kind === "usage.limits") publish?.(result.snapshot);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [snapshot, request, online, publish]);
  let best: { number: number; value: number; label: string; updatedAt: string } | null = null;
  for (const [index, account] of deduplicateUsageAccounts(snapshot?.accounts ?? []).filter((candidate) => candidate.providerId === providerId).entries()) {
    if (account.status !== "ready" || !account.updatedAt || account.sources.includes("This computer") || account.windows.length === 0) continue;
    const windows = account.windows.flatMap((window) => window.remainingPercent === null ? [] : [{ label: window.label, value: window.remainingPercent }]);
    if (windows.length !== account.windows.length) continue;
    const tightest = windows.reduce((low, window) => window.value < low.value ? window : low);
    if (tightest.value > (best?.value ?? remaining)) best = { number: index + 1, ...tightest, updatedAt: account.updatedAt };
  }
  if (!best) return null;
  const age = now - Date.parse(best.updatedAt) >= 300000 ? ageLabel(best.updatedAt, now) : null;
  return <p className="usage-accounts-hint" role="status"><span>Account {best.number} has more room</span><b>{Math.round(best.value)}% · {best.label}</b>{age && <small>Checked {age}</small>}</p>;
}
