import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorktreeSetupCard, type WorktreeSetupCommandRunner } from "../../src/renderer/src/components/WorktreeSetupCard";
import type { ServerEvent } from "../../src/shared/contracts";
import type { WorktreeSetupSummary } from "../../src/shared/worktree-setup";
import { conversation } from "./composer-fixtures";

function result(status: WorktreeSetupSummary["status"]): ServerEvent {
  return { type: "request.result", requestId: crypto.randomUUID(), result: {
    kind: "worktree.setup", output: "", summary: {
      actionName: "Install dependencies", status, attempt: status === "failed" ? 1 : 2,
      detail: "Preparing checkout", startedAt: null, finishedAt: null,
    },
  } };
}

describe("worktree setup recovery", () => {
  it("resumes polling after retrying setup from a reused checkout without an owner snapshot", async () => {
    const request = vi.fn<WorktreeSetupCommandRunner>()
      .mockResolvedValueOnce(result("failed"))
      // Retry acknowledges before the deferred setup attempt enters running state.
      .mockResolvedValueOnce(result("failed"))
      .mockResolvedValueOnce(result("running"))
      .mockResolvedValueOnce(result("succeeded"));
    render(<WorktreeSetupCard conversation={{ ...conversation("reused"), worktreePath: "/checkout" }} request={request} online />);
    await screen.findByRole("button", { name: "Retry setup" });
    vi.useFakeTimers();
    try {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry setup" })); });
      expect(screen.getByText("Setting up worktree")).toBeInTheDocument();
      expect(request.mock.calls.map(([, command]) => command.type))
        .toEqual(["worktree.setup.read", "worktree.setup.retry", "worktree.setup.read"]);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(screen.getByText("Worktree ready")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry setup" })).not.toBeInTheDocument();
    } finally { vi.useRealTimers(); }
  });

  it("refreshes after an ambiguous retry failure to expose an attempt that did start", async () => {
    const request = vi.fn<WorktreeSetupCommandRunner>()
      .mockResolvedValueOnce(result("failed"))
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(result("running"));
    const view = render(<WorktreeSetupCard conversation={{ ...conversation("reused"), worktreePath: "/checkout" }} request={request} online />);
    await screen.findByRole("button", { name: "Retry setup" });
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(screen.getByText("Setting up worktree")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted");
    view.unmount();
  });

  it("recovers inherited reads after reconnect and stops polling across identity changes and unmount", async () => {
    const request = vi.fn<WorktreeSetupCommandRunner>()
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValue(result("running"));
    const reused = { ...conversation("reused"), worktreePath: "/checkout" };
    vi.useFakeTimers();
    const view = render(<WorktreeSetupCard conversation={reused} request={request} online />);
    try {
      await act(async () => {});
      view.rerender(<WorktreeSetupCard conversation={reused} request={request} online={false} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(request).toHaveBeenCalledTimes(1);

      await act(async () => { view.rerender(<WorktreeSetupCard conversation={reused} request={request} online />); });
      expect(screen.getByText("Setting up worktree")).toBeInTheDocument();
      expect(request).toHaveBeenCalledTimes(2);

      view.rerender(<WorktreeSetupCard conversation={reused} request={request} online={false} />);
      expect(screen.getByRole("button", { name: "Stop setup" })).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(request).toHaveBeenCalledTimes(2);
      await act(async () => { view.rerender(<WorktreeSetupCard conversation={reused} request={request} online />); });

      const other = { ...conversation("other"), worktreePath: "/other-checkout" };
      await act(async () => { view.rerender(<WorktreeSetupCard conversation={other} request={request} online />); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(request.mock.calls.map(([, command]) => command.payload.conversationId))
        .toEqual(["reused", "reused", "reused", "other", "other"]);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(request).toHaveBeenCalledTimes(5);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
});
