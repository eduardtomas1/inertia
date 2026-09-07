import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import { COMPOSER_ACTION_STALE_FALLBACK_MS } from "../../src/renderer/src/utils/composerPrimaryAction";
import { composerProps, conversation, deferred } from "./composer-fixtures";

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("composer cancellation ownership", () => {
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
      expect(screen.getByRole("button", { name: "Stopping agent" })).toBeDisabled();

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
      expect(screen.getByRole("button", { name: "Stopping agent" })).toBeDisabled();
      expect(editor).toHaveValue("Keep this draft until stopped");

      view.rerender(<Composer {...composerProps(conversation("other-chat"))} />);
      view.rerender(<Composer {...stoppingProps} />);
      const restoredEditor = screen.getByRole("textbox", { name: "Message" });
      fireEvent.keyDown(restoredEditor, { key: "Enter" });
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stopping agent" })).toBeDisabled();
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
