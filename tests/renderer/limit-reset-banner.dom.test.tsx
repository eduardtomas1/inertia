import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LimitResetBanner } from "../../src/renderer/src/components/composer/LimitResetBanner";
import type { LimitResetCommandRunner } from "../../src/renderer/src/components/composer/limitResetClient";
import type { LimitResetResult } from "../../src/shared/limit-reset";

const conversationId = "11111111-1111-4111-8111-111111111111";
const failedTurnId = "22222222-2222-4222-8222-222222222222";
const id = "33333333-3333-4333-8333-333333333333";
const resetsAt = "2026-10-02T03:16:55.000Z";
const result = (): LimitResetResult => ({ kind: "conversation.limit-reset", conversationId,
  offer: { failedTurnId, resetsAt, canResume: true, unavailableReason: null }, plan: null, usageLimited: false });
const pending = (): LimitResetResult => ({ ...result(), plan: { id, conversationId, failedTurnId, resetsAt, state: "waiting", error: null } });
function banner(run: LimitResetCommandRunner, owner = conversationId, providerState = "ready") {
  return <LimitResetBanner conversationId={owner} latestTurnId={failedTurnId} snoozedUntil={null} disabled={false}
    providerState={providerState} onCommand={run} />;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("quota reset banner", () => {
  it("schedules only after an explicit click and cancels the returned plan identity", async () => {
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(result()).mockResolvedValueOnce(pending()).mockResolvedValueOnce(result());
    render(banner(run));
    await screen.findByRole("button", { name: "Resume at reset" });
    expect(run.mock.calls.map(([command]) => command.type)).toEqual(["conversation.limit-reset.get"]);
    fireEvent.click(screen.getByRole("button", { name: "Resume at reset" }));
    await screen.findByText("Resume scheduled");
    expect(run.mock.calls[1]![0]).toMatchObject({ type: "conversation.limit-reset.schedule", payload: { conversationId, failedTurnId, resetsAt, id: expect.any(String) } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel resume" }));
    await screen.findByRole("button", { name: "Resume at reset" });
    expect(run.mock.calls[2]![0]).toEqual({ type: "conversation.limit-reset.cancel", payload: { conversationId, id } });
  });
  it("keeps snoozing distinct from scheduling and supports keyboard focus", async () => {
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(result());
    render(banner(run));
    const snooze = await screen.findByRole("button", { name: "Snooze until reset" });
    snooze.focus(); expect(snooze).toHaveFocus(); fireEvent.click(snooze);
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1]![0]).toEqual({ type: "conversation.limit-reset.snooze", payload: { conversationId, failedTurnId, resetsAt } });
  });
  it("does not display an empty banner or invent controls for unavailable quota", async () => {
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue({ ...result(), offer: null });
    const view = render(banner(run));
    await act(async () => undefined);
    expect(view.container).toBeEmptyDOMElement();
  });
  it("says a usage limit was reached, without a time or actions, while no reset is reported", async () => {
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue({ ...result(), offer: null, usageLimited: true });
    render(banner(run));
    const row = await screen.findByRole("group", { name: "Usage limit" });
    expect(row).toHaveTextContent(/^Usage limit reached$/);
    expect(row).toHaveAttribute("data-state", "limited");
    expect(row.querySelector("time")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
  it("keeps the plain usage-limit row unfilled, with the status colour on its icon and words only", () => {
    const css = readFileSync(join(process.cwd(), "src/renderer/src/components/composer/LimitResetBanner.css"), "utf8");
    const limited = [...css.matchAll(/\.limit-reset\[data-state="limited"\]([^{]*)\{([^}]*)\}/gu)];
    expect(limited.find(([, selector]) => selector.trim() === "")?.[2]).toMatch(/background:\s*transparent;/u);
    expect(limited.find(([, selector]) => selector.trim() === ".limit-reset-copy strong")?.[2]).toMatch(/color:\s*var\(--warning\);/u);
  });
  it("drops a late response from a different chat", async () => {
    let resolve!: (value: LimitResetResult) => void;
    const promise = new Promise<LimitResetResult>((done) => { resolve = done; });
    const other = "44444444-4444-4444-8444-444444444444";
    const run = vi.fn<LimitResetCommandRunner>().mockReturnValueOnce(promise).mockResolvedValue({ ...result(), conversationId: other, offer: null });
    const view = render(banner(run));
    view.rerender(banner(run, other));
    await act(async () => { resolve(pending()); await promise; });
    expect(view.container).toBeEmptyDOMElement();
  });
  it("does not let an older poll restore a cancelled plan", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) + 60_000);
    let resolvePoll!: (value: LimitResetResult) => void;
    const poll = new Promise<LimitResetResult>((resolve) => { resolvePoll = resolve; });
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(pending()).mockReturnValueOnce(poll).mockResolvedValueOnce(result());
    const view = render(banner(run));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel resume" }));
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Resume at reset" })).toBeVisible();
    await act(async () => { resolvePoll(pending()); await poll; });
    expect(screen.queryByText("Resume scheduled")).not.toBeInTheDocument();
    view.unmount();
  });
  it("offers Resume now for a missed plan without sending automatically", async () => {
    const missed = pending(); missed.plan!.state = "missed"; missed.offer = null;
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(missed).mockResolvedValueOnce({ ...pending(), offer: null });
    render(banner(run));
    await screen.findByText("Resume missed");
    expect(screen.getByRole("status")).toHaveTextContent("nothing was sent");
    expect(screen.getByRole("button", { name: "Cancel resume" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resume now" }));
    await screen.findByText("Resume scheduled");
    expect(run.mock.calls[1]![0]).toEqual({ type: "conversation.limit-reset.resume", payload: { conversationId, id } });
  });
  it("explains a missed resume with the scheduler's reason when it gives one", async () => {
    const missed = pending(); missed.offer = null;
    missed.plan = { ...missed.plan!, state: "missed", error: "The provider did not report new quota within an hour of the reset, so nothing was sent." };
    render(banner(vi.fn<LimitResetCommandRunner>().mockResolvedValue(missed)));
    await screen.findByText("Resume missed");
    expect(screen.getByRole("status")).toHaveTextContent("did not report new quota within an hour of the reset");
    expect(screen.getByRole("button", { name: "Resume now" })).toBeVisible();
  });
  it("does not let an older turn's plan hide the offer for the latest failed turn", async () => {
    const newer = "55555555-5555-4555-8555-555555555555";
    const stale = pending(); stale.plan!.state = "blocked"; stale.plan!.error = "The chat changed.";
    stale.offer = { ...stale.offer!, failedTurnId: newer };
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(stale);
    render(<LimitResetBanner conversationId={conversationId} latestTurnId={newer} snoozedUntil={null} disabled={false} providerState="ready" onCommand={run} />);
    expect(await screen.findByRole("button", { name: "Resume at reset" })).toBeVisible();
    expect(screen.queryByText("Resume needs attention")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel resume" })).not.toBeInTheDocument();
  });
  it("explains a blocked automatic resume while retaining cancellation", async () => {
    const value = pending(); value.plan!.state = "blocked"; value.plan!.error = "The account changed. Resume manually.";
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(value);
    render(banner(run));
    await screen.findByText("Resume needs attention");
    expect(screen.getByRole("status")).toHaveTextContent("The account changed.");
    expect(screen.getByRole("button", { name: "Cancel resume" })).toBeEnabled();
  });
});

describe("quota reset account reads", () => {
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  it("reads a failed chat without a reported limit once instead of polling", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 3_600_000);
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue({ ...result(), offer: null });
    const view = render(banner(run)); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    view.rerender(banner(run, conversationId, "checking")); await flush();
    expect(run).toHaveBeenCalledOnce();
  });
  it("retries a rejected first read until the row has its data", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 3_600_000);
    const run = vi.fn<LimitResetCommandRunner>().mockRejectedValueOnce(new Error("The runtime restarted.")).mockResolvedValue(result());
    const view = render(banner(run)); await flush();
    expect(view.container).toBeEmptyDOMElement();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole("button", { name: "Resume at reset" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("asks again with a bounded backoff while a usage-limited chat has no offer yet", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 3_600_000);
    const empty = { ...result(), offer: null, usageLimited: true };
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(empty).mockResolvedValueOnce(empty).mockResolvedValue({ ...result(), usageLimited: true });
    render(banner(run)); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(run).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(screen.getByRole("button", { name: "Resume at reset" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("stops the backoff, then asks once more when the window returns or the provider changes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 3_600_000);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue({ ...result(), offer: null, usageLimited: true });
    const view = render(banner(run)); await flush();
    for (let step = 0; step < 8; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(run).toHaveBeenCalledTimes(5);
    focus.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("blur")); await vi.advanceTimersByTimeAsync(0); });
    focus.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0); });
    for (let step = 0; step < 4; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(run).toHaveBeenCalledTimes(6);
    view.rerender(banner(run, conversationId, "checking")); await flush();
    for (let step = 0; step < 4; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(run).toHaveBeenCalledTimes(7);
  });
  it("asks nothing more after unmount or a chat switch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 3_600_000);
    const other = "44444444-4444-4444-8444-444444444444";
    const run = vi.fn<LimitResetCommandRunner>(async (command) => command.payload.conversationId === other
      ? { ...result(), conversationId: other, offer: null }
      : { ...result(), offer: null, usageLimited: true });
    const view = render(banner(run)); await flush();
    view.rerender(banner(run, other)); await flush();
    for (let step = 0; step < 4; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(run.mock.calls.map(([command]) => command.payload.conversationId)).toEqual([conversationId, other]);
    const second = render(banner(run)); await flush();
    second.unmount();
    for (let step = 0; step < 4; step += 1) await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(run).toHaveBeenCalledTimes(3);
    view.unmount();
  });
  it("refreshes a reported limit once at its reset instead of polling", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 10 * 60_000);
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(result());
    render(banner(run)); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(9 * 60_000); });
    expect(run).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * 60_000); });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("waits for a focused, visible window before the first account read", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 3_600_000);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(result());
    render(banner(run)); await flush();
    expect(run).not.toHaveBeenCalled();
    focus.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(0); });
    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Resume at reset" })).toBeVisible();
  });
  it("defers the reset-time read while the window is hidden or unfocused", async () => {
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(resetsAt) - 5_000);
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(result());
    render(banner(run)); await flush();
    expect(run).toHaveBeenCalledOnce();
    focus.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("blur")); await vi.advanceTimersByTimeAsync(60_000); });
    expect(run).toHaveBeenCalledOnce();
    focus.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("focus")); await vi.advanceTimersByTimeAsync(30_000); });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("shows why automatic resume is unavailable as text tied to the action", async () => {
    const reason = "This login does not name a stable account, so Inertia cannot confirm it at the reset.";
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue({ ...result(), offer: { failedTurnId, resetsAt, canResume: false, unavailableReason: reason } });
    render(banner(run));
    const resume = await screen.findByRole("button", { name: "Resume at reset" });
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(resume).toHaveAccessibleDescription(reason);
    expect(screen.getByText(reason)).toBeVisible();
    expect(resume).not.toHaveAttribute("title");
  });
  it("shows the current limit after a rejected action", async () => {
    const moved = new Date(Date.parse(resetsAt) + 3_600_000).toISOString();
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error("The reported limit changed. Check the new reset time and try again."))
      .mockResolvedValueOnce({ ...result(), offer: { failedTurnId, resetsAt: moved, canResume: true, unavailableReason: null } });
    render(banner(run));
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("group", { name: "Usage limit" }).querySelector("time")).toHaveAttribute("dateTime", moved));
  });
});

describe("quota reset row lifetime", () => {
  it("produces no React warning when a read resolves after unmount", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let resolve!: (value: LimitResetResult) => void;
    const run = vi.fn<LimitResetCommandRunner>(() => new Promise((done) => { resolve = done; }));
    const view = render(banner(run));
    view.unmount();
    await act(async () => { resolve({ ...result(), offer: null }); });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("quota reset row inside the composer", () => {
  it("keeps focus on the action while busy and on its replacement after scheduling", async () => {
    let resolve!: (value: LimitResetResult) => void;
    const scheduled = new Promise<LimitResetResult>((done) => { resolve = done; });
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(result()).mockReturnValueOnce(scheduled);
    render(banner(run));
    const resume = await screen.findByRole("button", { name: "Resume at reset" });
    resume.focus();
    fireEvent.click(resume);
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(resume).not.toBeDisabled();
    expect(resume).toHaveFocus();
    fireEvent.click(resume);
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => { resolve(pending()); await scheduled; });
    const cancel = screen.getByRole("button", { name: "Cancel resume" });
    expect(cancel).toHaveFocus();
    expect(cancel).not.toHaveAttribute("aria-disabled");
  });
  it("keeps focus in the row when Resume now replaces the missed actions", async () => {
    const missed = pending(); missed.plan!.state = "missed"; missed.offer = null;
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(missed).mockResolvedValueOnce({ ...pending(), offer: null });
    render(banner(run));
    const resumeNow = await screen.findByRole("button", { name: "Resume now" });
    resumeNow.focus();
    fireEvent.click(resumeNow);
    await screen.findByText("Resume scheduled");
    expect(screen.getByRole("button", { name: "Cancel resume" })).toHaveFocus();
  });
  it("leaves focus where the user moved it while Resume now was pending", async () => {
    const missed = pending(); missed.plan!.state = "missed"; missed.offer = null;
    let resolve!: (value: LimitResetResult) => void;
    const resumed = new Promise<LimitResetResult>((done) => { resolve = done; });
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(missed).mockReturnValueOnce(resumed);
    render(<>{banner(run)}<textarea aria-label="Message" /></>);
    const resumeNow = await screen.findByRole("button", { name: "Resume now" });
    resumeNow.focus();
    fireEvent.click(resumeNow);
    const message = screen.getByRole("textbox", { name: "Message" });
    message.focus();
    await act(async () => { resolve({ ...pending(), offer: null }); await resumed; });
    expect(screen.getByText("Resume scheduled")).toBeVisible();
    expect(message).toHaveFocus();
  });
  it("marks unavailable actions without removing them from the focus order", async () => {
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue({ ...result(), offer: { failedTurnId, resetsAt, canResume: false, unavailableReason: "Secure storage is unavailable, so Inertia cannot confirm the account at the reset." } });
    render(<LimitResetBanner conversationId={conversationId} latestTurnId={failedTurnId} snoozedUntil={resetsAt} disabled={false} providerState="ready" onCommand={run} />);
    const resume = await screen.findByRole("button", { name: "Resume at reset" });
    const snoozed = screen.getByRole("button", { name: "Snoozed until reset" });
    expect(resume).toHaveAttribute("aria-disabled", "true");
    expect(snoozed).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(resume);
    fireEvent.click(snoozed);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("group", { name: "Usage limit" })).toBeInTheDocument();
  });
  it("reports a failed action as an alert without the diagnostic reference", async () => {
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(result()).mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error("The reported limit changed. Check the new reset time and try again. [incident:21feb702-c9bc-4896-a470-8cb97fd58d25]"));
    render(banner(run));
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^The reported limit changed\. Check the new reset time and try again\.$/u);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
