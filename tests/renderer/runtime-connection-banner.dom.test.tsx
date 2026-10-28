import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  connectionToastError,
  RUNTIME_RECONNECTING_NOTICE_DELAY_MS,
  RuntimeConnectionBanner,
} from "../../src/renderer/src/components/RuntimeConnectionBanner";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

type BannerConnection = Pick<InertiaConnection, "status" | "snapshot" | "runtimeStopped" | "restartRuntime">;

const restartableMessage = "The local service stopped. Restart it to continue.";
const blockedMessage = "Runtime startup is blocked because prior process cleanup remains unconfirmed. "
  + "Review Runtime diagnostics in Settings → Help.";

function connection(update: Partial<BannerConnection> = {}): BannerConnection {
  return {
    status: "online",
    snapshot: {} as NonNullable<InertiaConnection["snapshot"]>,
    runtimeStopped: null,
    restartRuntime: vi.fn(async () => undefined),
    ...update,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("runtime connection banner", () => {
  it("stays out of the way while the local service is online or first starting", () => {
    const view = render(<RuntimeConnectionBanner connection={connection()} />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<RuntimeConnectionBanner connection={connection({ status: "connecting", snapshot: null })} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("says it is reconnecting only after a brief disconnect has lasted, and leaves when online", () => {
    vi.useFakeTimers();
    const view = render(<RuntimeConnectionBanner connection={connection({ status: "offline" })} />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => { vi.advanceTimersByTime(RUNTIME_RECONNECTING_NOTICE_DELAY_MS); });
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting to the local service…");
    expect(screen.getByRole("status")).toHaveAttribute("data-connection-status", "offline");
    expect(screen.queryByRole("button")).toBeNull();

    view.rerender(<RuntimeConnectionBanner connection={connection({ status: "online" })} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("offers one Restart action when the local service stopped and can be restarted", () => {
    const restartRuntime = vi.fn(async () => undefined);
    render(<RuntimeConnectionBanner connection={connection({
      status: "offline",
      runtimeStopped: { restartable: true, message: restartableMessage },
      restartRuntime,
    })} />);

    expect(screen.getByRole("status")).toHaveTextContent(/^The local service stopped\.Restart$/u);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(restartRuntime).toHaveBeenCalledOnce();
  });

  it("moves focus to the message box instead of losing it when Restart leaves", async () => {
    const zone = document.createElement("div");
    zone.className = "composer-input-zone";
    const messageBox = document.createElement("textarea");
    zone.append(messageBox);
    document.body.append(zone);
    try {
      let finishRestart!: () => void;
      const restartRuntime = vi.fn(async () => await new Promise<void>((resolve) => { finishRestart = resolve; }));
      const view = render(<RuntimeConnectionBanner connection={connection({
        status: "offline",
        runtimeStopped: { restartable: true, message: restartableMessage },
        restartRuntime,
      })} />);
      const restart = screen.getByRole("button", { name: "Restart" });
      restart.focus();
      fireEvent.click(restart);
      view.rerender(<RuntimeConnectionBanner connection={connection({
        status: "connecting", runtimeStopped: null, restartRuntime,
      })} />);
      expect(document.activeElement).toBe(document.body);
      await act(async () => { finishRestart(); });
      expect(document.activeElement).toBe(messageBox);
    } finally {
      zone.remove();
    }
  });

  it("shows the runtime's own message when the app cannot restart the local service", () => {
    render(<RuntimeConnectionBanner connection={connection({
      status: "offline",
      snapshot: null,
      runtimeStopped: { restartable: false, message: blockedMessage },
    })} />);

    expect(screen.getByRole("status")).toHaveTextContent(blockedMessage);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not offer Restart when the app cannot restart the local service", () => {
    render(<RuntimeConnectionBanner connection={connection({
      status: "offline",
      snapshot: null,
      runtimeStopped: {
        restartable: false,
        message: "The local service stopped. Review Runtime diagnostics in Settings → Help before restarting Inertia.",
      },
    })} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "The local service stopped. Review Runtime diagnostics in Settings → Help before restarting Inertia.",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("runtime connection toast", () => {
  const stoppedWith = (message: string, error: string | null) => ({
    status: "offline" as const,
    snapshot: {} as NonNullable<InertiaConnection["snapshot"]>,
    runtimeStopped: { restartable: false, message },
    error,
  });

  it("leaves a stopped-service message to the banner that already shows it", () => {
    expect(connectionToastError(stoppedWith(blockedMessage, blockedMessage))).toBeNull();
    expect(connectionToastError({
      ...stoppedWith(restartableMessage, restartableMessage),
      runtimeStopped: { restartable: true, message: restartableMessage },
    })).toBeNull();
  });

  it("still shows a different connection error while the service is stopped", () => {
    expect(connectionToastError(stoppedWith(blockedMessage, "The local service could not be restarted.")))
      .toBe("The local service could not be restarted.");
  });

  it("shows only the banner while reconnecting to the local service", () => {
    expect(connectionToastError({
      status: "offline",
      snapshot: {} as NonNullable<InertiaConnection["snapshot"]>,
      runtimeStopped: null,
      error: "The local service is restarting. Try again in a moment.",
    })).toBeNull();
  });

  it("keeps the toast when no banner covers the error", () => {
    expect(connectionToastError({
      status: "connecting", snapshot: null, runtimeStopped: null,
      error: "The local service is starting. Try again in a moment.",
    })).toBe("The local service is starting. Try again in a moment.");
    expect(connectionToastError({
      status: "online",
      snapshot: {} as NonNullable<InertiaConnection["snapshot"]>,
      runtimeStopped: null,
      error: "Inertia could not apply a response from its local service.",
    })).toBe("Inertia could not apply a response from its local service.");
  });
});
