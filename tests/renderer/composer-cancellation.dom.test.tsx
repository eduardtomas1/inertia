import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import { useComposerStopAction } from "../../src/renderer/src/components/composer/useComposerStopAction";
import { COMPOSER_ACTION_STALE_FALLBACK_MS, STOP_REPEAT_LATCH_MS } from "../../src/renderer/src/utils/composerPrimaryAction";
import { composerProps, conversation, deferred } from "./composer-fixtures";

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("composer cancellation ownership", () => {
  it("keeps another chat's Stop latch when a prior chat's request rejects", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const { result, rerender } = renderHook(useComposerStopAction, {
      initialProps: { running: true, cancelling: false, conversationId: "first-chat", onStop: () => first.promise },
    });
    let firstStop!: Promise<boolean>;
    act(() => { firstStop = result.current.stop(); });
    rerender({ running: true, cancelling: false, conversationId: "second-chat", onStop: () => second.promise });
    let secondStop!: Promise<boolean>;
    act(() => { secondStop = result.current.stop(); });
    const secondClaim = result.current.stopClaimRef.current;

    await act(async () => {
      first.reject(new Error("The old request failed."));
      await firstStop;
    });
    expect(result.current.stopClaimRef.current).toBe(secondClaim);
    expect(result.current.stopping).toBe(true);

    await act(async () => {
      second.reject(new Error("The current request failed."));
      await secondStop;
    });
    expect(result.current.stopClaimRef.current).toBeNull();
    expect(result.current.stopping).toBe(false);
  });

  it("returns focus to the message box once Stop is accepted", async () => {
    const stopped = deferred<void>();
    render(<Composer {...composerProps(conversation("stop-focus"), { running: true, onStop: () => stopped.promise })} />);
    const stop = await screen.findByRole("button", { name: "Stop agent" });
    stop.focus();
    fireEvent.click(stop);

    await act(async () => stopped.resolve());

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  });

  it("keeps focus on Stop when the stop request fails", async () => {
    const stopped = deferred<void>();
    render(<Composer {...composerProps(conversation("stop-focus-failure"), { running: true, onStop: () => stopped.promise })} />);
    const stop = await screen.findByRole("button", { name: "Stop agent" });
    stop.focus();
    fireEvent.click(stop);

    await act(async () => stopped.reject(new Error("Stop failed.")));

    expect(screen.getByRole("button", { name: "Stop agent" })).toHaveFocus();
  });

  it("asks the runtime again when Stop is pressed while the turn is stopping, but not on a double click", async () => {
    const current = conversation("conversation-force-stop");
    const onStop = vi.fn(async () => undefined);
    const cancellingTurn = {
      ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
      id: "turn-force-stop",
      status: "running" as const,
      harnessId: "codex-app-server" as const,
      runState: { state: "cancelling" as const, providerState: "cancel/requested", revision: 2 },
    };
    render(<Composer {...composerProps(current, { running: true, latestTurn: cancellingTurn, onStop })} />);
    const stopping = await screen.findByRole("button", { name: "Stopping agent" });
    expect(stopping).toBeEnabled();
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(stopping);
      fireEvent.click(stopping);
    });
    expect(onStop).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STOP_REPEAT_LATCH_MS);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stopping agent" }));
    });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it.each(["detail", "summary"] as const)(
    "keeps follow-ups blocked until %s confirms cancellation has finished",
    async (projection) => {
      const current = conversation(`conversation-stopping-${projection}`);
      const stopped = deferred<void>();
      const onStop = vi.fn(() => stopped.promise);
      const onSend = vi.fn(async () => undefined);
      const runningTurn = {
        ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
        id: `turn-stopping-${projection}`,
        status: "running" as const,
        harnessId: "codex-app-server" as const,
        runState: { state: "running" as const, providerState: null, revision: 1 },
      };
      const props = composerProps(current, { running: true, latestTurn: runningTurn, onStop, onSend });
      const view = render(<Composer {...props} />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Stop agent" }))
        .toHaveAttribute("data-motion-state", "stop"));
      const editor = screen.getByRole("textbox", { name: "Message" });
      fireEvent.change(editor, { target: { value: "Keep this draft until stopped" } });
      vi.useFakeTimers();

      fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onStop).toHaveBeenCalledOnce();
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stopping agent" })).toHaveAttribute("aria-busy", "true");

      const cancellingTurn = {
        ...runningTurn,
        runState: { state: "cancelling" as const, providerState: "cancel/requested", revision: 2 },
      };
      const stoppingProps = {
        ...props,
        ...(projection === "summary"
          ? { latestTurnSummary: cancellingTurn }
          : { latestTurn: cancellingTurn }),
      };
      view.rerender(<Composer {...stoppingProps} />);
      await act(async () => {
        stopped.resolve();
        await stopped.promise;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPOSER_ACTION_STALE_FALLBACK_MS + 1);
      });
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stopping agent" })).toBeEnabled();
      expect(editor).toHaveValue("Keep this draft until stopped");

      view.rerender(<Composer {...composerProps(conversation("other-chat"))} />);
      view.rerender(<Composer {...stoppingProps} />);
      const restoredEditor = screen.getByRole("textbox", { name: "Message" });
      fireEvent.keyDown(restoredEditor, { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stopping agent" })).toBeEnabled();
      expect(restoredEditor).toHaveValue("Keep this draft until stopped");

      view.rerender(<Composer {...props} running={false} latestTurn={{
        ...runningTurn,
        status: "cancelled",
        runState: { state: "cancelled", providerState: null, revision: 3 },
      }} />);
      fireEvent.keyDown(restoredEditor, { key: "Enter" });
      expect(onSend).toHaveBeenCalledExactlyOnceWith("Keep this draft until stopped", [], undefined);
    },
  );
});
