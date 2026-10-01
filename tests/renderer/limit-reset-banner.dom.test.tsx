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
  offer: { failedTurnId, resetsAt, canResume: true }, plan: null });
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
    vi.useFakeTimers();
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
  it("explains a blocked automatic resume while retaining cancellation", async () => {
    const value = pending(); value.plan!.state = "blocked"; value.plan!.error = "The account changed. Resume manually.";
    const run = vi.fn<LimitResetCommandRunner>().mockResolvedValue(value);
    render(banner(run));
    await screen.findByText("Resume needs attention");
    expect(screen.getByRole("status")).toHaveTextContent("The account changed.");
    expect(screen.getByRole("button", { name: "Cancel resume" })).toBeEnabled();
  });
});
