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
  offer: { failedTurnId, resetsAt, canResume: true }, needsCheck: false, plan: null });
const pending = (): LimitResetResult => ({ ...result(), plan: { id, conversationId, failedTurnId, resetsAt, state: "waiting", error: null } });
function banner(run: LimitResetCommandRunner, owner = conversationId) {
  return <LimitResetBanner conversationId={owner} latestTurnId={failedTurnId} snoozedUntil={null} disabled={false} onCommand={run} />;
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
    render(banner(run)); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(run).toHaveBeenCalledOnce();
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
  it("reads a Keychain-backed account only after the explicit check", async () => {
    const unchecked: LimitResetResult = { ...result(), offer: null, needsCheck: true };
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(unchecked)
      .mockResolvedValueOnce({ ...result(), offer: { failedTurnId, resetsAt, canResume: false } }).mockResolvedValue(unchecked);
    render(banner(run));
    fireEvent.click(await screen.findByRole("button", { name: "Check reset time" }));
    expect(run.mock.calls[1]![0]).toEqual({ type: "conversation.limit-reset.get", payload: { conversationId, refresh: true } });
    expect(await screen.findByRole("button", { name: "Resume at reset" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Snooze until reset" })).not.toHaveAttribute("aria-disabled");
  });
  it("shows the current limit after a rejected action", async () => {
    const moved = new Date(Date.parse(resetsAt) + 3_600_000).toISOString();
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error("The reported limit changed. Check the new reset time and try again."))
      .mockResolvedValueOnce({ ...result(), offer: { failedTurnId, resetsAt: moved, canResume: true } });
    render(banner(run));
    fireEvent.click(await screen.findByRole("button", { name: "Resume at reset" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("group", { name: "Usage limit" }).querySelector("time")).toHaveAttribute("dateTime", moved));
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
  it("marks unavailable actions without removing them from the focus order", async () => {
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue({ ...result(), offer: { failedTurnId, resetsAt, canResume: false } });
    render(<LimitResetBanner conversationId={conversationId} latestTurnId={failedTurnId} snoozedUntil={resetsAt} disabled={false} onCommand={run} />);
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
