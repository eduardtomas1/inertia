import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { limitTone, UsageAccountsHint, UsageLimitsPanel } from "../../src/renderer/src/components/UsageLimitsPanel";
import { UsageLimitsProvider } from "../../src/renderer/src/components/usage-limits-context";
import type { ServerEvent } from "../../src/shared/contracts";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { usageAccount } from "../helpers/usage-limits";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function limitsResult(accounts: UsageAccount[]): ServerEvent {
  return { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "usage.limits", snapshot: { accounts, sources: [], checkedAt: new Date().toISOString() } } };
}
function fixture() {
  const account = usageAccount();
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "usage.reset.prepare") return { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "usage.reset.confirmation", confirmation: { id: "a5b39646-2790-44dc-9266-25b6985c36b7", accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: "test-credit-a", expiresAt: new Date(Date.now() + 120000).toISOString() } } };
    if (command.type === "usage.reset.confirm") throw new Error("simulated timeout");
    return limitsResult([account]);
  });
  return { account, request };
}
const showCodexAccounts = async (): Promise<void> => { fireEvent.click(await screen.findByRole("button", { name: "Show Codex accounts" })); };
const window = (id: string, label: string, remainingPercent: number, resetsAt: string, windowMinutes: number) => ({ id, label, remainingPercent, windowMinutes, resetsAt });

describe("Limits overview", () => {
  it("shows each provider as one strip with pooled windows, health tones and accounts under a toggle", async () => {
    const soon = new Date(Date.now() + 90 * 60000).toISOString();
    const later = new Date(Date.now() + 2 * 86400000).toISOString();
    const codex = usageAccount({ windows: [window("codex:primary", "5-hour window", 64, soon, 300), window("codex:weekly", "Weekly", 12, later, 10080)] });
    const second = usageAccount({ id: "hub:codex-second", identityKey: "account-c", sources: ["Home hub"], credits: null, canReset: false,
      windows: [window("codex:primary", "5-hour window", 90, soon, 300), window("codex:weekly", "Weekly", 40, later, 10080)] });
    const claude = usageAccount({ id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account", identityKey: "account-b", credits: null, canReset: false,
      windows: [window("claude:five", "Claude · 5 hour", 35, soon, 300)] });
    render(<UsageLimitsPanel status="online" request={vi.fn(async () => limitsResult([codex, second, claude]))} />);

    const codexRegion = await screen.findByRole("region", { name: "Codex limits" });
    expect(within(codexRegion).getByRole("heading", { level: 3 })).toHaveTextContent("Codex2 accounts");
    expect(codexRegion.querySelector('[data-provider-id="codex"]')).not.toBeNull();
    const pooled = [...codexRegion.querySelectorAll(".limits-strip .limits-cell")];
    expect(pooled.map((cell) => cell.textContent)).toEqual(["5-hour window77% avg of 2in 1h 30m", "Weekly26% avg of 2in 2d 0h"]);
    expect(pooled.map((cell) => cell.getAttribute("data-tone"))).toEqual(["ok", "low"]);
    const claudeRegion = screen.getByRole("region", { name: "Claude limits" });
    expect(claudeRegion.querySelector('[data-provider-id="claude"]')).not.toBeNull();
    expect(claudeRegion.querySelector(".limits-strip .limits-cell")).toHaveAttribute("data-tone", "low");
    expect(screen.getByText("Checked just now")).toBeVisible();

    const accounts = codexRegion.querySelector(".limits-strip-accounts");
    expect(accounts).toHaveAttribute("inert");
    fireEvent.click(within(codexRegion).getByRole("button", { name: "Show Codex accounts" }));
    expect(within(codexRegion).getByRole("button", { name: "Hide Codex accounts" })).toHaveAttribute("aria-expanded", "true");
    expect(codexRegion).toHaveAttribute("data-open");
    expect(accounts).not.toHaveAttribute("inert");
    const first = within(codexRegion).getByRole("button", { name: /1 Codex account pro ready 2 resets/ });
    expect([...first.querySelectorAll(".limits-cell")].map((cell) => cell.getAttribute("data-tone"))).toEqual(["ok", "critical"]);
    const secondRow = within(codexRegion).getByRole("button", { name: /2 Codex account pro ready/ });
    expect([...secondRow.querySelectorAll(".limits-cell")].map((cell) => cell.getAttribute("data-tone"))).toEqual(["ok", "low"]);
    expect(claudeRegion.querySelector(".limits-strip-accounts")).toHaveAttribute("inert");
  });

  it("keeps the averages explanation behind the info control", async () => {
    render(<UsageLimitsPanel status="online" request={fixture().request} />);
    const about = await screen.findByRole("button", { name: "About these numbers" });
    const explanation = screen.getByText(/Account averages give each equivalent account equal weight/);
    expect(explanation).not.toBeVisible();
    fireEvent.click(about);
    expect(about).toHaveAttribute("aria-expanded", "true");
    expect(explanation).toBeVisible();
  });

  it("shows a skeleton while the first read is pending", async () => {
    let resolve!: (event: ServerEvent) => void;
    const request = vi.fn(async (): Promise<ServerEvent> => new Promise<ServerEvent>((done) => { resolve = done; }));
    const view = render(<UsageLimitsPanel status="online" request={request} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Reading provider accounts…");
    expect(view.container.querySelectorAll(".limits-skeleton > span")).toHaveLength(3);
    await act(async () => { resolve(limitsResult([usageAccount()])); });
    expect(view.container.querySelector(".limits-skeleton")).toBeNull();
    expect(screen.getByRole("region", { name: "Codex limits" })).toBeVisible();
  });

  it("marks stale accounts without a health colour", () => {
    expect(limitTone(80, true)).toBe("stale");
    expect(limitTone(null, false)).toBe("unknown");
    expect(limitTone(50, false)).toBe("ok");
    expect(limitTone(49, false)).toBe("low");
    expect(limitTone(19, false)).toBe("critical");
  });
});

describe("Limits interface", () => {
  it("keeps identity hidden, opens details by keyboard and requires explicit confirmation", async () => {
    const f = fixture(); const user = userEvent.setup();
    render(<UsageLimitsPanel status="online" request={f.request} />);
    await showCodexAccounts();
    const account = screen.getByRole("button", { name: /1 Codex account pro ready 2 resets/ });
    account.focus(); await user.keyboard("{Enter}");
    expect(screen.queryByText("fixture@example.test")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByText("fixture@example.test")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Use reset" }));
    await screen.findByRole("button", { name: "Confirm reset" });
    expect(f.request.mock.calls.some(([command]) => command.type === "usage.reset.confirm")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Confirm reset" }));
    await user.click(await screen.findByRole("button", { name: "Retry same reset" }));
    const confirmations = f.request.mock.calls.filter(([command]) => command.type === "usage.reset.confirm");
    expect(confirmations).toHaveLength(2); expect(confirmations[0]).toEqual(confirmations[1]);
  });
  it("recovers a pending last-credit attempt after remount even when the fresh count is zero", async () => {
    const f = fixture(); const user = userEvent.setup();
    const first = render(<UsageLimitsPanel status="online" request={f.request} />);
    await showCodexAccounts();
    await user.click(screen.getByRole("button", { name: /1 Codex account pro ready 2 resets/ }));
    await user.click(screen.getByRole("button", { name: "Use reset" }));
    await user.click(await screen.findByRole("button", { name: "Confirm reset" }));
    await screen.findByRole("button", { name: "Retry same reset" }); first.unmount();
    f.account.credits = { availableCount: 0, nextCreditId: null, expiresAt: null }; f.account.canReset = false; f.account.pendingReset = true;
    render(<UsageLimitsPanel status="online" request={f.request} />);
    await showCodexAccounts();
    await user.click(screen.getByRole("button", { name: /1 Codex account pro ready 0 resets/ }));
    await user.click(screen.getByRole("button", { name: "Check pending reset" }));
    await user.click(await screen.findByRole("button", { name: "Retry same reset" }));
    const sent = f.request.mock.calls.filter(([command]) => command.type === "usage.reset.confirm");
    expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1]);
  });
  it("does not steal focus when the user moves during reset preparation", async () => {
    const f = fixture(); render(<UsageLimitsPanel status="online" request={f.request} />);
    await showCodexAccounts();
    fireEvent.click(screen.getByRole("button", { name: /1 Codex account pro ready 2 resets/ }));
    const prepared = await f.request.getMockImplementation()!({ type: "usage.reset.prepare", payload: { accountId: f.account.id } });
    let resolve!: (event: ServerEvent) => void; const pending = new Promise<ServerEvent>((done) => { resolve = done; });
    f.request.mockImplementationOnce(async () => pending);
    const launch = screen.getByRole("button", { name: "Use reset" }); launch.focus(); fireEvent.click(launch);
    const moved = screen.getByRole("button", { name: "Reveal" }); moved.focus();
    await act(async () => { resolve(prepared); await pending; });
    expect(screen.getByRole("button", { name: "Confirm reset" })).toBeVisible(); expect(moved).toHaveFocus();
  });
  it("does not refresh from the composer until explicitly requested", async () => {
    const f = fixture(); render(<UsageLimitsPanel status="online" request={f.request} compact />);
    await waitFor(() => expect(f.request).toHaveBeenCalledOnce());
    expect(f.request.mock.calls[0]?.[0]).toEqual({ type: "usage.limits.get", payload: { refresh: false, force: false } });
  });
  it("stops periodic work while hidden and after unmount", async () => {
    vi.useFakeTimers(); const f = fixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<UsageLimitsPanel status="online" request={f.request} />);
    await act(async () => { await Promise.resolve(); });
    expect(f.request).toHaveBeenCalledOnce();
    visibility.mockReturnValue("hidden"); await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(f.request).toHaveBeenCalledOnce();
    visibility.mockReturnValue("visible"); await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(f.request).toHaveBeenCalledTimes(2);
    view.unmount(); await vi.advanceTimersByTimeAsync(180000); expect(f.request).toHaveBeenCalledTimes(2);
  });
});

describe("Composer account hint", () => {
  const soon = new Date(Date.now() + 90 * 60000).toISOString();
  const later = new Date(Date.now() + 2 * 86400000).toISOString();
  const windows = (short: number, weekly: number) => [window("codex:primary", "5-hour window", short, soon, 300), window("codex:weekly", "Weekly", weekly, later, 10080)];
  const hub = (update: Partial<UsageAccount>): UsageAccount => usageAccount({ id: "hub:codex-second", identityKey: "account-c", sources: ["Home hub"], ...update });
  function renderHint(accounts: UsageAccount[], remaining: number) {
    const request = vi.fn(async (): Promise<ServerEvent> => limitsResult(accounts));
    render(<UsageLimitsProvider request={request} status="online"><UsageAccountsHint providerId="codex" remaining={remaining} /></UsageLimitsProvider>);
    return request;
  }

  it("reads cached limits once and names the account with more room than the current route", async () => {
    const request = renderHint([usageAccount({ sources: ["This computer", "Home hub"], windows: windows(58, 23) }), hub({ windows: windows(91, 75) })], 23);
    expect(await screen.findByRole("status")).toHaveTextContent(/^Account 2 has more room75% · Weekly$/u);
    expect(request).toHaveBeenCalledExactlyOnceWith({ type: "usage.limits.get", payload: { refresh: false, force: false } });
  });

  it("stays silent when no other ready, fully reported account has more room", async () => {
    const request = renderHint([
      usageAccount({ sources: ["This computer"], windows: windows(80, 70) }),
      hub({ windows: windows(91, 60) }),
      hub({ id: "hub:stale", identityKey: "account-d", status: "stale", windows: windows(99, 99) }),
      hub({ id: "hub:partial", identityKey: "account-e", windows: [window("codex:primary", "5-hour window", 95, soon, 300), { ...window("codex:weekly", "Weekly", 0, later, 10080), remainingPercent: null }] }),
    ], 70);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says when the other account was last checked", async () => {
    renderHint([usageAccount({ sources: ["This computer"] }), hub({ updatedAt: new Date(Date.now() - 2 * 3600000).toISOString(), windows: windows(91, 75) })], 23);
    expect(await screen.findByRole("status")).toHaveTextContent("Checked 2h ago");
  });
});
