import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageLimitsPanel } from "../../src/renderer/src/components/UsageLimitsPanel";
import type { ServerEvent } from "../../src/shared/contracts";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { usageAccount } from "../helpers/usage-limits";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  const account = usageAccount();
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type === "usage.reset.prepare") return { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "usage.reset.confirmation", confirmation: { id: "a5b39646-2790-44dc-9266-25b6985c36b7", accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: "test-credit-a", expiresAt: new Date(Date.now() + 120000).toISOString() } } };
    if (command.type === "usage.reset.confirm") throw new Error("simulated timeout");
    return { type: "request.result", requestId: crypto.randomUUID(), result: { kind: "usage.limits", snapshot: { accounts: [account], sources: [], checkedAt: new Date().toISOString() } } };
  });
  return { account, request };
}
describe("Limits interface", () => {
  it("keeps identity hidden, opens details by keyboard and requires explicit confirmation", async () => {
    const f = fixture(); const user = userEvent.setup();
    render(<UsageLimitsPanel status="online" request={f.request} />);
    const account = await screen.findByRole("button", { name: /1 Codex account pro ready 2 resets/ });
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
    await user.click(await screen.findByRole("button", { name: /1 Codex account pro ready 2 resets/ }));
    await user.click(screen.getByRole("button", { name: "Use reset" }));
    await user.click(await screen.findByRole("button", { name: "Confirm reset" }));
    await screen.findByRole("button", { name: "Retry same reset" }); first.unmount();
    f.account.credits = { availableCount: 0, nextCreditId: null, expiresAt: null }; f.account.canReset = false; f.account.pendingReset = true;
    render(<UsageLimitsPanel status="online" request={f.request} />);
    await user.click(await screen.findByRole("button", { name: /1 Codex account pro ready 0 resets/ }));
    await user.click(screen.getByRole("button", { name: "Check pending reset" }));
    await user.click(await screen.findByRole("button", { name: "Retry same reset" }));
    const sent = f.request.mock.calls.filter(([command]) => command.type === "usage.reset.confirm");
    expect(sent).toHaveLength(2); expect(sent[0]).toEqual(sent[1]);
  });
  it("does not steal focus when the user moves during reset preparation", async () => {
    const f = fixture(); render(<UsageLimitsPanel status="online" request={f.request} />);
    fireEvent.click(await screen.findByRole("button", { name: /1 Codex account pro ready 2 resets/ }));
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
