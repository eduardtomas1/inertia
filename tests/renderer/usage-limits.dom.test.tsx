import { readSourceText } from "../helpers/source-text";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageLimitsPanel } from "../../src/renderer/src/components/UsageLimitsPanel";
import { UsageAccountsHint } from "../../src/renderer/src/components/usage/UsageAccountsHint";
import { UsageLimitsProvider } from "../../src/renderer/src/components/usage-limits-context";
import type { ServerEvent } from "../../src/shared/contracts";
import type { UsageAccount, UsageLimitsSnapshot } from "../../src/shared/provider-usage-limits";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { usageAccount } from "../helpers/usage-limits";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function limitsEvent(snapshot: UsageLimitsSnapshot): ServerEvent {
  return { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "usage.limits", snapshot } };
}
function limitsResult(accounts: UsageAccount[]): ServerEvent {
  return limitsEvent({ accounts, sources: [], checkedAt: new Date().toISOString() });
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
const window = (id: string, label: string, remainingPercent: number | null, resetsAt: string | null, windowMinutes: number | null) => ({ id, label, remainingPercent, windowMinutes, resetsAt });
const segment = (name: RegExp): Promise<HTMLElement> => screen.findByRole("button", { name });
const figures = (region: HTMLElement): string[] => [...region.querySelectorAll(".limit-card")].map((card) => (
  `${card.querySelector(".limit-card-label")?.textContent} ${card.querySelector(".limit-card-figure")?.textContent}`
));
const limitsCalls = (request: { mock: { calls: Array<[CommandWithoutId]> } }): unknown[] => request.mock.calls
  .map(([command]) => command).flatMap((command) => command.type === "usage.limits.get" ? [command.payload] : []);
const READ = { refresh: false, force: false };
const REFRESH = { refresh: true, force: false };
const BACKGROUND = { refresh: true, force: false, background: true };

describe("Limits overview", () => {
  it("shows a section per provider with a card per window, one segment per account, chips and pace", async () => {
    const soon = new Date(Date.now() + 90 * 60000 + 30000).toISOString();
    const later = new Date(Date.now() + 2 * 86400000 + 30000).toISOString();
    const codex = usageAccount({ windows: [window("codex:primary", "Session", 64, soon, 300), window("codex:secondary", "Weekly", 12, later, 10080)] });
    const second = usageAccount({ id: "hub:codex-second", identityKey: "account-c", sources: ["Home hub"], credits: null, canReset: false,
      windows: [window("codex:primary", "Session", 90, soon, 300), window("codex:secondary", "Weekly", 40, later, 10080)] });
    const claude = usageAccount({ id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account", identityKey: "account-b", credits: null, canReset: false,
      windows: [window("claude:five_hour", "Session", 35, soon, 300), window("claude:overage", "Extra usage", 100, null, null)] });
    render(<UsageLimitsPanel status="online" request={vi.fn(async () => limitsResult([codex, second, claude]))} />);

    const codexRegion = await screen.findByRole("region", { name: "Codex limits" });
    expect(within(codexRegion).getByRole("heading", { level: 3 })).toHaveTextContent(/^Codex$/u);
    expect(codexRegion.querySelector('[data-provider-id="codex"]')).not.toBeNull();
    expect(figures(codexRegion)).toEqual(["Session 77%left", "Weekly 26%left"]);
    expect(within(codexRegion).getByRole("button", { name: "Codex account 1: 64% left, resets in 1h 30m, 30% of the window left, 2 reset credits banked" })).toBeVisible();
    expect(within(codexRegion).getByRole("button", { name: "Codex account 2: 90% left, resets in 1h 30m, 30% of the window left" })).toBeVisible();
    const [session, weekly] = [...codexRegion.querySelectorAll<HTMLElement>(".limit-card")];
    expect([...session!.querySelectorAll(".limit-segment .limit-chip")].map((chip) => chip.textContent)).toEqual(["↻ 1h 30m·2", "↻ 1h 30m"]);
    expect([...session!.querySelectorAll(".limit-segment-name")].map((name) => name.textContent)).toEqual(["Account 1", "Account 2"]);
    expect([...session!.querySelectorAll<HTMLElement>(".limit-bar-fill")].map((fill) => fill.style.width)).toEqual(["64%", "90%"]);
    expect([...session!.querySelectorAll<HTMLElement>(".limit-bar-hatch")].map((hatch) => hatch.style.width)).toEqual(["36%", "10%"]);
    expect([...session!.querySelectorAll<HTMLElement>(".limit-bar")].map((bar) => bar.style.getPropertyValue("--limit-mark"))).toEqual(["30%", "30%"]);
    expect(session!.querySelector(".limit-card-refill")).toHaveTextContent("↻ +18%");
    expect(within(session!).getByRole("img", { name: "Under pace: headroom left for the rest of the window" })).toBeVisible();
    expect(within(weekly!).getByRole("img", { name: "On pace with the window" })).toBeVisible();

    const claudeRegion = screen.getByRole("region", { name: "Claude limits" });
    expect(figures(claudeRegion)).toEqual(["Session 35%left", "Extra usage 100%left"]);
    expect(claudeRegion.querySelectorAll(".limit-segment-name")).toHaveLength(0);
    const extra = claudeRegion.querySelectorAll<HTMLElement>(".limit-card")[1]!;
    expect(extra.querySelector(".limit-chip")).toBeNull();
    expect(extra.querySelector(".limit-bar-mark")).toBeNull();
    expect(within(extra).queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Checked just now")).toBeVisible();
  });

  it("draws the bar from tokens: provider colour, hatched restore, pace slot and reduced motion", () => {
    const bar = readSourceText("src/renderer/src/components/usage/LimitBar.css");
    const panel = readSourceText("src/renderer/src/components/UsageLimitsPanel.css");
    expect(bar).toMatch(/:is\(\.limit-bar, \.limits-provider\)\[data-provider="claude"\] \{ --limit-color: var\(--usage-series-claude\); \}/u);
    expect(bar).toContain("repeating-linear-gradient(135deg, var(--limit-color) 0 1px, transparent 1px 5px)");
    expect(bar).toContain("--limit-at: clamp(3px, var(--limit-mark, 50%), calc(100% - 3px));");
    expect(bar).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\n  \.limit-bar-fill,\n  \.limit-bar-hatch \{\n    transition:/u);
    expect(panel).toMatch(/@container limit-bars \(min-width: 672px\)/u);
    const untokened = `${bar}${panel}`.split("\n").filter((line) => !line.includes("--usage-series-")).join("\n");
    expect(untokened).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/iu);
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

  it("says what an agent reports instead of drawing an empty bar, with the account details one step away", async () => {
    const cursor = usageAccount({ id: "native:cursor", providerId: "cursor", providerLabel: "Cursor", label: "Cursor account", identityKey: null, status: "unavailable", detail: "Usage is not reported by this agent.", windows: [], credits: null, canReset: false });
    const key = usageAccount({ id: "profile:work", providerId: "custom", providerLabel: "Work key", label: "Work key", identityKey: null, plan: null, status: "unavailable", detail: "Usage and limits are not available for API keys.", sources: ["Configured route"], windows: [], credits: null, canReset: false });
    render(<UsageLimitsPanel status="online" request={vi.fn(async () => limitsResult([cursor, key]))} />);
    const region = await screen.findByRole("region", { name: "Cursor limits" });
    expect(within(region).getByText("Usage is not reported by this agent.")).toBeVisible();
    expect(region.querySelector(".limit-bar")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Work key limits" })).getByText("Usage and limits are not available for API keys.")).toBeVisible();
    fireEvent.click(within(region).getByRole("button", { name: "Cursor account details" }));
    const details = within(region).getByRole("group", { name: "Cursor account details" });
    expect(details).toHaveTextContent("Identity unverified; this account stays separate to avoid double counting.");
    expect(details).toHaveTextContent("Reset credits not reported.");
  });

  it("applies the provider and source filters and says when nothing matches", async () => {
    const hub = usageAccount({ id: "hub:1:second", identityKey: "account-c", sources: ["Home hub"] });
    const claude = usageAccount({ id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account", identityKey: "account-b" });
    const snapshot = { accounts: [usageAccount(), hub, claude], sources: [{ id: "1", label: "Home hub", url: "https://hub.example.test", enabled: true, error: null }], checkedAt: new Date().toISOString() };
    const request = vi.fn(async () => limitsEvent(snapshot));
    const view = render(<UsageLimitsPanel status="online" request={request} hiddenProviderIds={new Set(["claude"])} />);
    expect(await screen.findByRole("region", { name: "Codex limits" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Claude limits" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Codex account \d: / })).toHaveLength(2);
    view.rerender(<UsageLimitsPanel status="online" request={request} source="1" />);
    expect(screen.getAllByRole("button", { name: /^Codex account: / })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Claude limits" })).not.toBeInTheDocument();
    view.rerender(<UsageLimitsPanel status="online" request={request} source="local" hiddenProviderIds={new Set(["codex", "claude"])} />);
    expect(screen.getByText("No accounts match these filters.")).toBeVisible();
  });

  it("says a passed reset is due without the old percentage or a manual refresh", async () => {
    const due = usageAccount({ windows: [window("codex:primary", "Session", 0, new Date(Date.now() - 60000).toISOString(), 300)] });
    render(<UsageLimitsPanel status="online" request={vi.fn(async () => limitsResult([due]))} />);
    const region = await screen.findByRole("region", { name: "Codex limits" });
    expect(figures(region)).toEqual(["Session Resetdue"]);
    expect(region.querySelector(".limit-chip")).toHaveTextContent("Reset due");
    expect(region.querySelector(".limit-bar")).toHaveAttribute("data-due", "true");
    expect(region.querySelector(".limit-bar-mark")).toBeNull();
    expect(screen.queryByText(/refresh to check/)).not.toBeInTheDocument();
  });
});

describe("Limits loading", () => {
  const cachedAt = new Date(Date.now() - 10 * 60000).toISOString();
  const codexAt = (remaining: number, update: Partial<UsageAccount> = {}): UsageAccount => usageAccount({
    windows: [window("codex:primary", "Session", remaining, new Date(Date.now() + 7200000).toISOString(), 300)], ...update,
  });
  const claudeAt = (remaining: number, update: Partial<UsageAccount> = {}): UsageAccount => usageAccount({
    id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account", identityKey: "account-b", credits: null, canReset: false,
    windows: [window("claude:five_hour", "Session", remaining, new Date(Date.now() + 7200000).toISOString(), 300)], ...update,
  });
  const cached = { status: "stale" as const, canReset: false, updatedAt: cachedAt, checkedAt: null };
  const figure = (name: string): string | null | undefined => screen.getByRole("region", { name }).querySelector(".limit-card-figure strong")?.textContent;
  const refreshing = (name: string): boolean => screen.getByRole("region", { name }).querySelector(".limit-segment")!.hasAttribute("data-refreshing");

  it("renders cached values before the refresh answers, keeps them through a slow refresh and updates each account as it lands", async () => {
    vi.useFakeTimers();
    let snapshot: UsageLimitsSnapshot = { accounts: [codexAt(64, cached), claudeAt(35, cached)], sources: [], checkedAt: null };
    let finish!: (event: ServerEvent) => void;
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "usage.limits.get" && command.payload.refresh) return new Promise<ServerEvent>((resolve) => { finish = resolve; });
      return limitsEvent(snapshot);
    });
    const view = render(<UsageLimitsPanel status="online" request={request} />);
    await act(async () => { await Promise.resolve(); });

    expect(limitsCalls(request)).toEqual([READ, REFRESH]);
    expect([figure("Codex limits"), figure("Claude limits")]).toEqual(["64%", "35%"]);
    expect(view.container.querySelector(".limits-skeleton")).toBeNull();
    expect(screen.queryByText("Reading provider accounts…")).not.toBeInTheDocument();
    expect([refreshing("Codex limits"), refreshing("Claude limits")]).toEqual([true, true]);
    expect(screen.getByText("Refreshing…")).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect([figure("Codex limits"), figure("Claude limits")]).toEqual(["64%", "35%"]);

    const landed = new Date().toISOString();
    snapshot = { ...snapshot, accounts: [codexAt(41, { updatedAt: landed, checkedAt: landed }), claudeAt(35, cached)] };
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect([figure("Codex limits"), figure("Claude limits")]).toEqual(["41%", "35%"]);
    expect([refreshing("Codex limits"), refreshing("Claude limits")]).toEqual([false, true]);

    const done = new Date().toISOString();
    await act(async () => { finish(limitsEvent({ accounts: [codexAt(41, { updatedAt: landed, checkedAt: landed }), claudeAt(80, { updatedAt: done, checkedAt: done })], sources: [], checkedAt: done })); });
    expect([figure("Codex limits"), figure("Claude limits")]).toEqual(["41%", "80%"]);
    expect([refreshing("Codex limits"), refreshing("Claude limits")]).toEqual([false, false]);
    expect(screen.getByText("Checked just now")).toBeVisible();
    const settled = request.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(request).toHaveBeenCalledTimes(settled);
    view.unmount();
  });

  it("starts from the snapshot the app already holds without asking for it again", async () => {
    const snapshot: UsageLimitsSnapshot = { accounts: [codexAt(64, cached)], sources: [], checkedAt: null };
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => (
      command.type === "usage.limits.get" && command.payload.refresh ? new Promise<ServerEvent>(() => undefined) : limitsEvent(snapshot)
    ));
    function Late(): React.JSX.Element {
      const [shown, setShown] = useState(false);
      return (
        <UsageLimitsProvider request={request} status="online">
          <UsageAccountsHint providerId="codex" remaining={100} />
          <button type="button" onClick={() => setShown(true)}>Show limits</button>
          {shown && <UsageLimitsPanel status="online" request={request} />}
        </UsageLimitsProvider>
      );
    }
    render(<Late />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Show limits" }));
    expect(figure("Codex limits")).toBe("64%");
    await act(async () => { await Promise.resolve(); });
    expect(limitsCalls(request)).toEqual([READ, REFRESH]);
  });

  it("stops re-reading the cache when the popup closes during a slow refresh and stays quiet on background refreshes", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const snapshot: UsageLimitsSnapshot = { accounts: [codexAt(64, cached)], sources: [], checkedAt: new Date().toISOString() };
    let finish: ((event: ServerEvent) => void) | null = null;
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "usage.limits.get" && command.payload.background) return new Promise<ServerEvent>((resolve) => { finish = resolve; });
      return limitsEvent(snapshot);
    });
    const view = render(<UsageLimitsPanel status="online" request={request} />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(181000); });
    expect(finish).not.toBeNull();
    expect(limitsCalls(request).at(-1)).toEqual(READ);
    expect(refreshing("Codex limits")).toBe(false);
    expect(screen.getByText("Refreshing…")).toBeVisible();
    view.unmount();
    const sent = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).toHaveBeenCalledTimes(sent);
  });

  it("shows a skeleton only while there is nothing to show", async () => {
    let resolve!: (event: ServerEvent) => void;
    const request = vi.fn(async (): Promise<ServerEvent> => new Promise<ServerEvent>((done) => { resolve = done; }));
    const view = render(<UsageLimitsPanel status="online" request={request} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Reading provider accounts…");
    expect(view.container.querySelectorAll(".limits-skeleton > span")).toHaveLength(3);
    await act(async () => { resolve(limitsResult([usageAccount()])); });
    expect(view.container.querySelector(".limits-skeleton")).toBeNull();
    expect(screen.getByRole("region", { name: "Codex limits" })).toBeVisible();
  });

  it("keeps the last values and says so when a refresh fails", async () => {
    const snapshot: UsageLimitsSnapshot = { accounts: [codexAt(64)], sources: [], checkedAt: new Date().toISOString() };
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
      if (command.type === "usage.limits.get" && command.payload.refresh) throw new Error("offline");
      return limitsEvent(snapshot);
    });
    render(<UsageLimitsPanel status="online" request={request} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh failed. Previously reported limits may be stale.");
    expect(figure("Codex limits")).toBe("64%");
    expect(screen.getByRole("region", { name: "Codex limits" }).querySelector(".limit-card-note")).toHaveTextContent("Stale");
  });

  it("forces a refresh when the popup asks and reports its progress", async () => {
    const f = fixture(); const busy = vi.fn();
    const view = render(<UsageLimitsPanel status="online" request={f.request} refreshToken={0} onBusyChange={busy} />);
    await segment(/^Codex account: 60% left/);
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
    view.rerender(<UsageLimitsPanel status="online" request={f.request} refreshToken={1} onBusyChange={busy} />);
    await waitFor(() => expect(limitsCalls(f.request).at(-1)).toEqual({ refresh: true, force: true }));
    expect(busy).toHaveBeenCalledWith(true);
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  });

  it("refreshes in the background when it becomes visible with a reading older than three minutes", async () => {
    vi.useFakeTimers(); const f = fixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<UsageLimitsPanel status="online" request={f.request} />);
    await act(async () => { await Promise.resolve(); });
    const toggle = async (state: DocumentVisibilityState): Promise<void> => {
      visibility.mockReturnValue(state);
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    };
    await toggle("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    await toggle("visible");
    expect(limitsCalls(f.request)).toEqual([READ, REFRESH]);
    await toggle("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(130000); });
    await toggle("visible");
    await act(async () => { await Promise.resolve(); });
    expect(limitsCalls(f.request)).toEqual([READ, REFRESH, BACKGROUND]);
    view.unmount();
  });

  it("stops periodic work while hidden and after unmount", async () => {
    vi.useFakeTimers(); const f = fixture();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const view = render(<UsageLimitsPanel status="online" request={f.request} />);
    await act(async () => { await Promise.resolve(); });
    expect(limitsCalls(f.request)).toEqual([READ, REFRESH]);
    visibility.mockReturnValue("hidden"); await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(limitsCalls(f.request)).toHaveLength(2);
    visibility.mockReturnValue("visible"); await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await Promise.resolve(); });
    expect(limitsCalls(f.request)).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(180000); });
    expect(limitsCalls(f.request)).toEqual([READ, REFRESH, BACKGROUND, BACKGROUND]);
    view.unmount(); await vi.advanceTimersByTimeAsync(180000); expect(limitsCalls(f.request)).toHaveLength(4);
  });
});

describe("Limits account details", () => {
  it("keeps identity hidden, opens details by keyboard and requires explicit confirmation", async () => {
    const f = fixture(); const user = userEvent.setup();
    render(<UsageLimitsPanel status="online" request={f.request} />);
    const account = await segment(/^Codex account: 60% left/);
    expect(account).toHaveAttribute("aria-expanded", "false");
    account.focus(); await user.keyboard("{Enter}");
    expect(account).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByRole("group", { name: "Codex account details" });
    expect(details).toHaveAttribute("id", account.getAttribute("aria-controls"));
    expect(within(details).getByText("pro")).toBeVisible();
    expect(within(details).getByText("This computer")).toBeVisible();
    expect(within(details).getByText("2 banked resets")).toBeVisible();
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
  it("keeps an uncertain attempt when the details are closed and opened again", async () => {
    const f = fixture(); const user = userEvent.setup();
    render(<UsageLimitsPanel status="online" request={f.request} />);
    const account = await segment(/^Codex account: 60% left/);
    await user.click(account);
    await user.click(screen.getByRole("button", { name: "Use reset" }));
    await user.click(await screen.findByRole("button", { name: "Confirm reset" }));
    await screen.findByRole("button", { name: "Retry same reset" });
    await user.click(account);
    expect(screen.queryByRole("group", { name: "Codex account details" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Codex account details" }));
    expect(screen.getByRole("button", { name: "Retry same reset" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("The result is uncertain. Retry this attempt; do not start another reset.");
  });
  it("recovers a pending last-credit attempt after remount even when the fresh count is zero", async () => {
    const f = fixture(); const user = userEvent.setup();
    const first = render(<UsageLimitsPanel status="online" request={f.request} />);
    await user.click(await segment(/^Codex account: 60% left/));
    await user.click(screen.getByRole("button", { name: "Use reset" }));
    await user.click(await screen.findByRole("button", { name: "Confirm reset" }));
    await screen.findByRole("button", { name: "Retry same reset" }); first.unmount();
    f.account.credits = { availableCount: 0, nextCreditId: null, expiresAt: null }; f.account.canReset = false; f.account.pendingReset = true;
    render(<UsageLimitsPanel status="online" request={f.request} />);
    const account = await segment(/^Codex account: 60% left/);
    expect(account).not.toHaveAccessibleName(/banked/);
    await user.click(account);
    await user.click(screen.getByRole("button", { name: "Check pending reset" }));
    await user.click(await screen.findByRole("button", { name: "Retry same reset" }));
    const sent = f.request.mock.calls.filter(([command]) => command.type === "usage.reset.confirm");
    expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1]);
  });
  it("does not steal focus when the user moves during reset preparation", async () => {
    const f = fixture(); render(<UsageLimitsPanel status="online" request={f.request} />);
    fireEvent.click(await segment(/^Codex account: 60% left/));
    const prepared = await f.request.getMockImplementation()!({ type: "usage.reset.prepare", payload: { accountId: f.account.id } });
    let resolve!: (event: ServerEvent) => void; const pending = new Promise<ServerEvent>((done) => { resolve = done; });
    f.request.mockImplementationOnce(async () => pending);
    const launch = screen.getByRole("button", { name: "Use reset" }); launch.focus(); fireEvent.click(launch);
    const moved = screen.getByRole("button", { name: "Reveal" }); moved.focus();
    await act(async () => { resolve(prepared); await pending; });
    expect(screen.getByRole("button", { name: "Confirm reset" })).toBeVisible(); expect(moved).toHaveFocus();
  });
  it("moves focus into the confirmation and back to the reset control on cancel", async () => {
    const f = fixture(); const user = userEvent.setup();
    render(<UsageLimitsPanel status="online" request={f.request} />);
    await user.click(await segment(/^Codex account: 60% left/));
    await user.click(screen.getByRole("button", { name: "Use reset" }));
    expect(await screen.findByRole("button", { name: "Confirm reset" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Use reset" })).toHaveFocus();
  });
  it("lists every hub and keeps the form for adding one", async () => {
    const snapshot = { accounts: [usageAccount()], sources: [{ id: "1", label: "Home hub", url: "https://hub.example.test", enabled: true, error: "The hub could not be read." }], checkedAt: new Date().toISOString() };
    const request = vi.fn(async (): Promise<ServerEvent> => limitsEvent(snapshot));
    render(<UsageLimitsPanel status="online" request={request} />);
    expect(await screen.findByText("Home hub: The hub could not be read.")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByText("Usage sources"));
    expect(screen.getByText("1 hub")).toBeVisible();
    expect(within(screen.getByText("Home hub", { selector: "strong" }).closest(".limits-source-row") as HTMLElement).getByText("The hub could not be read.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith({ type: "usage.source.remove", payload: { id: "1" } }));
    expect(screen.getByLabelText("Hub URL")).toBeRequired();
    expect(screen.getByRole("button", { name: "Add hub" })).toBeDisabled();
  });
});

describe("Composer account hint", () => {
  const soon = new Date(Date.now() + 90 * 60000).toISOString();
  const later = new Date(Date.now() + 2 * 86400000).toISOString();
  const windows = (short: number, weekly: number) => [window("codex:primary", "Session", short, soon, 300), window("codex:weekly", "Weekly", weekly, later, 10080)];
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
      hub({ id: "hub:partial", identityKey: "account-e", windows: [window("codex:primary", "Session", 95, soon, 300), { ...window("codex:weekly", "Weekly", 0, later, 10080), remainingPercent: null }] }),
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
