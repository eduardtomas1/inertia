import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMascot } from "../../src/renderer/src/mascot/Mascot";
import { emptyMascotStatus, type MascotSnapshot } from "../../src/shared/mascot";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "mascot"); document.body.replaceChildren(); });

function renderMascot() {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = mountMascot(container, window.mascot);
  return { container, unmount: () => { dispose(); container.remove(); } };
}

function fixture() {
  let snapshot: MascotSnapshot = { preferences: { enabled: true, motion: true }, status: emptyMascotStatus() };
  let receive = (_value: MascotSnapshot): void => undefined;
  const unsubscribe = vi.fn();
  const action = vi.fn(async () => undefined);
  const media = new EventTarget() as MediaQueryList;
  Object.defineProperty(media, "matches", { value: false, configurable: true });
  vi.stubGlobal("matchMedia", () => media);
  window.mascot = {
    snapshot: async () => snapshot, action,
    onChanged: (listener) => { receive = listener; return unsubscribe; },
  };
  return {
    action, unsubscribe, media,
    update(phase: MascotSnapshot["status"]["phase"], motion = true): void {
      snapshot = {
        preferences: { enabled: true, motion },
        status: { phase, conversationId: "chat", projectId: "project", runId: "run", turnId: "turn", activeCount: phase === "running" ? 1 : 0 },
      };
      act(() => receive(snapshot));
    },
  };
}

describe("mascot rendering", () => {
  it("stays static at idle, pauses active work, and uses reduced-motion posters", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const image = view.container.querySelector("img")!;
    expect(image.dataset.animated).toBe("false");
    app.update("running");
    expect(image.dataset.animated).toBe("true");
    app.update("running", false);
    expect(image.dataset.animated).toBe("false");
    app.update("running");
    Object.defineProperty(app.media, "matches", { value: true });
    act(() => { app.media.dispatchEvent(new Event("change")); });
    expect(image.dataset.animated).toBe("false");
    view.unmount();
    expect(app.unsubscribe).toHaveBeenCalledOnce();
  });

  it("finishes the completion cue once and retains readable terminal labels", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    vi.useFakeTimers();
    app.update("completed");
    expect(view.container.querySelector("img")?.dataset.animated).toBe("true");
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(view.container.querySelector("img")?.dataset.animated).toBe("false");
    expect(screen.getByRole("status")).toHaveTextContent("Work complete");
    app.update("failed");
    expect(screen.getByRole("status")).toHaveTextContent("Something went wrong");
  });

  it("supports keyboard positioning, hiding, and explicit chat activation", async () => {
    const app = fixture();
    renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    app.update("running");
    const button = screen.getByRole("button", { name: "Working. Open chat" });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    fireEvent.keyDown(button, { key: "Escape" });
    expect(app.action).toHaveBeenNthCalledWith(1, "open-chat", expect.objectContaining({
      conversationId: "chat", projectId: "project", runId: "run", turnId: "turn",
    }));
    expect(app.action).toHaveBeenNthCalledWith(2, "left");
    expect(app.action).toHaveBeenNthCalledWith(3, "hide");
  });
});
