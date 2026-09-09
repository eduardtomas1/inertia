import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMascot } from "../../src/renderer/src/mascot/Mascot";
import { emptyMascotStatus, type MascotBridge, type MascotSnapshot } from "../../src/shared/mascot";
import documentMarkup from "../../src/renderer/mascot.html?raw";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "mascot"); document.body.replaceChildren(); });

function renderMascot() {
  const container = document.createElement("div");
  container.innerHTML = new DOMParser().parseFromString(documentMarkup, "text/html").querySelector("#root")!.innerHTML;
  document.body.append(container);
  const dispose = mountMascot(container, window.mascot);
  let mounted = true;
  const unmount = (): void => { if (mounted) { mounted = false; dispose(); container.remove(); } };
  disposals.push(unmount);
  return { container, unmount };
}

function fixture() {
  let snapshot: MascotSnapshot = { preferences: { enabled: true, motion: true }, status: emptyMascotStatus(), gesture: [1, 0] };
  let receive = (_value: MascotSnapshot): void => undefined;
  const unsubscribe = vi.fn();
  const action = vi.fn<MascotBridge["action"]>(async () => undefined);
  const media = new EventTarget() as MediaQueryList;
  Object.defineProperty(media, "matches", { value: false, configurable: true });
  vi.stubGlobal("matchMedia", () => media);
  window.mascot = {
    snapshot: async () => snapshot, action,
    onChanged: (listener) => { receive = listener; return unsubscribe; },
  };
  return {
    action, unsubscribe, media,
    interaction(dragging: boolean, placement?: "system", gesture = 1): void {
      snapshot = { ...snapshot, dragging, placement, gesture: [1, gesture] };
      act(() => receive(snapshot));
    },
    update(phase: MascotSnapshot["status"]["phase"], motion = true, context: Partial<MascotSnapshot["status"]> = {}): void {
      snapshot = {
        ...snapshot,
        preferences: { enabled: true, motion },
        status: { ...emptyMascotStatus(), phase, conversationId: "chat", projectId: "project", runId: "run", turnId: "turn", activeCount: phase === "running" ? 1 : 0, ...context },
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

  it("announces real questions as text with the chat name and a contextual action", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    app.update("waiting-for-input", true, { chatTitle: "Improve mascot", message: "Use <img onerror=alert(1)> in the example?", progress: "2 questions to answer" });
    expect(screen.getByRole("status")).toHaveTextContent("Use <img onerror=alert(1)> in the example?");
    expect(view.container.querySelectorAll("img")).toHaveLength(2);
    expect(view.container.querySelector(".mascot-content img")).toBeNull();
    const button = screen.getByRole("button", { name: /Improve mascot.*2 questions to answer.*Answer in chat/ });
    fireEvent.click(button);
    expect(app.action).toHaveBeenCalledWith("open-chat", expect.objectContaining({ conversationId: "chat", message: "Use <img onerror=alert(1)> in the example?" }));
    app.update("waiting-for-approval", true, { message: "Run the test suite" });
    expect(screen.getByRole("button", { name: /Run the test suite.*Review approval/ })).toBeEnabled();
    app.update("completed", true, { message: "Bubble updated. Tests passed." });
    expect(screen.getByRole("button", { name: /Bubble updated. Tests passed.*View result/ })).toBeEnabled();
  });

  it("supports keyboard positioning, hiding, and explicit chat activation", async () => {
    const app = fixture();
    renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    app.update("running");
    const button = screen.getByRole("button", { name: /Working.*Open chat/ });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    fireEvent.keyDown(button, { key: "Escape" });
    expect(app.action).toHaveBeenNthCalledWith(1, "open-chat", expect.objectContaining({
      conversationId: "chat", projectId: "project", runId: "run", turnId: "turn",
    }));
    expect(app.action).toHaveBeenNthCalledWith(2, "left");
    expect(app.action).toHaveBeenNthCalledWith(3, "hide");
  });

  it("keeps activity current while held and returns to the latest state without replaying a finished cue", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    vi.useFakeTimers();
    const activity = view.container.querySelector<HTMLImageElement>(".mascot-activity")!;
    const pickup = view.container.querySelector<HTMLImageElement>(".mascot-pickup")!;
    app.update("running");
    app.interaction(true);
    expect(pickup.src).toContain("pickup.webp");
    expect(pickup.dataset.animated).toBe("true");
    expect(activity.dataset.animated).toBe("false");
    app.update("waiting-for-approval", true, { message: "Run tests?" });
    expect(view.container.querySelector("main")?.dataset.dragging).toBe("true");
    expect(screen.getByRole("status")).toHaveTextContent("Run tests?");
    app.update("completed");
    act(() => { vi.advanceTimersByTime(3_000); });
    app.interaction(false);
    expect(activity.src).toContain("idea.png");
    expect(pickup.dataset.animated).toBe("false");
    expect(pickup.src).toContain("pickup.png");
    expect(vi.getTimerCount()).toBe(0);
    app.update("running"); app.interaction(true); app.interaction(false);
    expect(activity.src).toContain("working.webp");
  });

  it("shows the static pickup pose for paused, reduced-motion, and hidden surfaces", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const pickup = view.container.querySelector<HTMLImageElement>(".mascot-pickup")!;
    app.interaction(true);
    app.update("running", false);
    expect(pickup.dataset.animated).toBe("false");
    expect(view.container.querySelector("main")?.dataset.motion).toBe("false");
    app.update("running");
    Object.defineProperty(app.media, "matches", { value: true, configurable: true });
    app.media.dispatchEvent(new Event("change"));
    expect(pickup.src).toContain("pickup.png");
    Object.defineProperty(app.media, "matches", { value: false });
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(pickup.dataset.animated).toBe("false");
    hidden.mockRestore();
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture", "released move", "blur", "unmount"])("captures a mouse pickup and releases exactly once on %s", async (ending) => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const handle = view.container.querySelector<HTMLElement>(".mascot-drag")!;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, pointerType: "mouse", isPrimary: true });
    expect(app.action).toHaveBeenCalledWith("pickup", [1, 1]);
    expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    app.interaction(true);
    fireEvent.pointerMove(window, { pointerId: 7, buttons: 1 });
    expect(app.action.mock.calls.map(([action]) => action)).toEqual(["pickup"]);
    if (ending === "unmount") view.unmount();
    else if (ending === "blur") fireEvent(window, new Event("blur"));
    else if (ending === "released move") fireEvent.pointerMove(window, { pointerId: 7, buttons: 0 });
    else fireEvent(ending === "lostpointercapture" ? handle : window, new PointerEvent(ending, { pointerId: 7 }));
    fireEvent.pointerUp(window, { pointerId: 7 });
    if (ending === "unmount") {
      fireEvent.keyDown(handle, { key: "ArrowDown" });
      fireEvent.pointerDown(handle, { button: 0, pointerId: 8, pointerType: "mouse", isPrimary: true });
    }
    expect(app.action.mock.calls.map(([action]) => action)).toEqual(["pickup", "drop"]);
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("does not start a custom drag for right click, a secondary pointer, or compositor placement", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const handle = view.container.querySelector<HTMLElement>(".mascot-drag")!;
    handle.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { button: 2, pointerType: "mouse", isPrimary: true });
    fireEvent.pointerDown(handle, { button: 0, pointerType: "mouse", isPrimary: false });
    app.interaction(false, "system");
    fireEvent.pointerDown(handle, { button: 0, pointerType: "mouse", isPrimary: true });
    expect(app.action).not.toHaveBeenCalled();
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
  });

  it("keeps the new mouse capture when an old drop snapshot or pickup failure arrives", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const handle = view.container.querySelector<HTMLElement>(".mascot-drag")!;
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = vi.fn();
    let rejectFirst!: (error: Error) => void;
    app.action.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }));
    const press = (): void => { fireEvent.pointerDown(handle, { button: 0, pointerId: 7, pointerType: "mouse", isPrimary: true }); };
    press();
    fireEvent.pointerUp(window, { pointerId: 7 });
    press();
    app.interaction(true, undefined, 1);
    app.interaction(false, undefined, 1);
    await act(async () => { rejectFirst(new Error("Previous gesture failed")); });
    expect(handle.releasePointerCapture).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).not.toHaveTextContent("Use Settings to move with keyboard");
    app.interaction(true, undefined, 2);
    fireEvent.pointerUp(window, { pointerId: 7 });
    expect(app.action.mock.calls).toEqual([
      ["pickup", [1, 1]], ["drop", [1, 1]], ["pickup", [1, 2]], ["drop", [1, 2]],
    ]);
    expect(handle.releasePointerCapture).toHaveBeenCalledTimes(2);
    // An older idle notification cannot make the next press reuse an identity.
    app.interaction(false, undefined, 1);
    press();
    expect(app.action).toHaveBeenLastCalledWith("pickup", [1, 3]);
    fireEvent.pointerUp(window, { pointerId: 7 });
  });
});
