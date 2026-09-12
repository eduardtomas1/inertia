import { UsageLimitsPanel } from "../../src/renderer/src/components/UsageLimitsPanel";
import { USAGE_RESET_CONFIRMATION_EXPIRED } from "../../src/shared/provider-usage-limits";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageIndicator } from "../../src/renderer/src/components/UsageIndicator";
import { UsageLimitsProvider } from "../../src/renderer/src/components/usage-limits-context";
import { useUsageLimitsContext } from "../../src/renderer/src/components/usage-limits-state";
import { usageAccount } from "../helpers/usage-limits";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type { ServerEvent } from "../../src/shared/contracts";
afterEach(() => vi.restoreAllMocks());
it("keeps keyboard focus inside Limits after the shortcut's next animation frame", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
  const request = async (): Promise<ServerEvent> => ({ type: "request.result", requestId: "request", result: { kind: "usage.limits", snapshot: { accounts: [], sources: [], checkedAt: null } } });
  render(<UsageLimitsProvider request={request} status="online"><UsageIndicator usage={null} rateLimits={[]} rateLimitState={{ freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false }} quotaSource="selected-route" mode="expanded" providerLabel="Codex" onModeChange={() => undefined} /></UsageLimitsProvider>);
  const trigger = screen.getByRole("button", { name: /Open usage and context/ });
  trigger.focus(); fireEvent.click(trigger);
  const shortcut = screen.getByRole("button", { name: "All provider limits" });
  shortcut.focus();
  await act(async () => { fireEvent.click(shortcut); await vi.dynamicImportSettled(); });
  const dialog = await screen.findByRole("dialog", { name: "Provider usage limits" });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  
  await act(async () => { for (const frame of frames.splice(0)) frame(performance.now()); });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Provider usage limits" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  // The loaded lazy module must keep the same ownership on a warm reopen.
  fireEvent.click(trigger);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "All provider limits" })); await vi.dynamicImportSettled(); });
  const reopened = await screen.findByRole("dialog", { name: "Provider usage limits" });
  await act(async () => { for (const frame of frames.splice(0)) frame(performance.now()); });
  expect(reopened).toContainElement(document.activeElement as HTMLElement);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(trigger).toHaveFocus();
});

function Opener() { const context = useUsageLimitsContext(); return <button onClick={() => context!.open()}>Open limits directly</button>; }
it("retains modal focus when reset preparation replaces its launching button", async () => {
  const account = usageAccount();
  const request = async (command: CommandWithoutId): Promise<ServerEvent> => ({ type: "request.result", requestId: "request", result: command.type === "usage.reset.prepare"
    ? { kind: "usage.reset.confirmation", confirmation: { id: "a5b39646-2790-44dc-9266-25b6985c36b7", accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: "test-credit-a", expiresAt: new Date(Date.now() + 120000).toISOString() } }
    : { kind: "usage.limits", snapshot: { accounts: [account], sources: [], checkedAt: new Date().toISOString() } } });
  render(<UsageLimitsProvider request={request} status="online"><Opener /></UsageLimitsProvider>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open limits directly" })); await vi.dynamicImportSettled(); });
  const dialog = await screen.findByRole("dialog", { name: "Provider usage limits" });
  fireEvent.click(await screen.findByRole("button", { name: /1 Codex account pro ready 2 resets/ }));
  const useReset = screen.getByRole("button", { name: "Use reset" });
  useReset.focus();
  await act(async () => fireEvent.click(useReset));
  await screen.findByRole("button", { name: "Confirm reset" });
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Provider usage limits" })).not.toBeInTheDocument();
});

it("renews an expired unattempted confirmation instead of offering an endless same-confirmation retry", async () => {
  const account = usageAccount();
  let now = Date.now();
  const expires = now + 120000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "usage.reset.confirm") throw new Error(USAGE_RESET_CONFIRMATION_EXPIRED);
    return { type: "request.result", requestId: "request", result: command.type === "usage.reset.prepare"
      ? { kind: "usage.reset.confirmation", confirmation: { id: "a5b39646-2790-44dc-9266-25b6985c36b7", accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: "test-credit-a", expiresAt: new Date(now + 120000).toISOString() } }
      : { kind: "usage.limits", snapshot: { accounts: [account], sources: [], checkedAt: new Date(now).toISOString() } } };
  });
  render(<UsageLimitsPanel request={request} status="online" />);
  fireEvent.click(await screen.findByRole("button", { name: /1 Codex account pro ready 2 resets/ }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use reset" })));
  now = expires + 1;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm reset" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Renew confirmation" })));
  expect(request.mock.calls.filter(([command]) => command.type === "usage.reset.prepare")).toHaveLength(2);
  expect(request.mock.calls.filter(([command]) => command.type === "usage.reset.confirm")).toHaveLength(0);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm reset" })); });
  // The provider can reject an expiry raced during transport, before dispatch.
  expect(screen.getByRole("button", { name: "Renew confirmation" })).toBeVisible();
  expect(screen.queryByText(/The result is uncertain/)).not.toBeInTheDocument();
});
