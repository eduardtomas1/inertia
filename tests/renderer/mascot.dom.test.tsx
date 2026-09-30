import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountMascot } from "../../src/renderer/src/mascot/Mascot";
import { emptyMascotStatus, type MascotBridge, type MascotCounts, type MascotSnapshot, type MascotStatus } from "../../src/shared/mascot";
import { MASCOT_SPRITE_STATES, type MascotSprites } from "../../src/shared/mascot-sprites";
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
    customize(sprites?: MascotSprites): void {
      snapshot = { ...snapshot, sprites };
      act(() => receive(snapshot));
    },
    interaction(dragging: boolean, placement?: "system", gesture = 1): void {
      snapshot = { ...snapshot, dragging, placement, gesture: [1, gesture] };
      act(() => receive(snapshot));
    },
    list(status: MascotStatus, chats: MascotStatus[], pinned: string | null = null, counts?: MascotCounts): void {
      snapshot = { ...snapshot, status, chats, pinned, counts };
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

function chat(id: string, phase: MascotStatus["phase"], context: Partial<MascotStatus> = {}): MascotStatus {
  return { ...emptyMascotStatus(), phase, conversationId: id, projectId: "project", runId: `${id}-run`, turnId: `${id}-turn`,
    activeCount: 2, chatTitle: `Chat ${id}`, projectName: "Inertia", ...context };
}

describe("mascot chat context and chooser", () => {
  it("shows project, elapsed time, and measured plan progress for the shown chat", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-06T10:12:30.000Z"), toFake: ["Date", "setTimeout", "clearTimeout"] });
    const app = fixture();
    const view = renderMascot();
    await act(async () => { await Promise.resolve(); });
    const working = chat("a", "running", { since: "2026-09-06T10:00:00.000Z", steps: { completed: 3, total: 5 }, progress: "3 of 5 steps complete" });
    app.list(working, [working]);
    const text = (selector: string): string => view.container.querySelector(selector)!.textContent!;
    expect(text(".mascot-time")).toBe("12m");
    expect(text(".mascot-project")).toBe("Inertia");
    expect(text(".mascot-detail")).toBe("3 of 5 steps");
    expect(view.container.querySelector<HTMLElement>(".mascot-steps")!.hidden).toBe(false);
    expect(view.container.querySelector<HTMLElement>(".mascot-steps i")!.style.getPropertyValue("--mascot-steps")).toBe("0.6");
    expect(view.container.querySelector<HTMLButtonElement>(".mascot-picker")!.hidden).toBe(true);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(text(".mascot-time")).toBe("13m");
    const done = chat("b", "completed", { since: "2026-09-06T10:10:00.000Z", steps: { completed: 5, total: 5 } });
    app.list(emptyMascotStatus(), [done]);
    expect(view.container.querySelector<HTMLButtonElement>(".mascot-picker")!.hidden).toBe(false);
    app.list(done, [done]);
    expect(text(".mascot-time")).toBe("3m ago");
    expect(view.container.querySelector<HTMLElement>(".mascot-steps")!.hidden).toBe(true);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lists chats, pins a choice, flags other chats that need attention, and returns to automatic", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const question = chat("q", "waiting-for-input");
    const working = chat("w", "running");
    app.list(question, [question, working]);
    const picker = screen.getByRole("button", { name: /Show chat: most urgent\. 2 chats/ });
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(picker.dataset.attention).toBe("false");
    fireEvent.click(picker);
    expect(picker).toHaveAttribute("aria-expanded", "true");
    const group = screen.getByRole("group", { name: "Show chat" });
    expect([...group.querySelectorAll("button")].map((row) => row.textContent)).toEqual(["Most urgent chatAuto", "Chat qInertiaNeeds you", "Chat wInertiaWorking"]);
    expect(within(group).getByRole("button", { name: /Most urgent/ })).toHaveAttribute("aria-pressed", "true");
    expect(document.activeElement).toBe(within(group).getByRole("button", { name: /Most urgent/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toHaveTextContent("Chat w");
    fireEvent.click(document.activeElement!);
    expect(app.action).toHaveBeenLastCalledWith("pin", "w");
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(view.container.querySelector<HTMLElement>(".mascot-chooser")!.hidden).toBe(true);
    app.list(working, [question, working], "w");
    expect(picker).toHaveTextContent("Pinned");
    expect(picker.dataset.attention).toBe("true");
    expect(screen.getByRole("button", { name: /Chat w.*1 other chat needs you.*Open chat/ })).toBeEnabled();
    fireEvent.click(picker);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(app.action).not.toHaveBeenCalledWith("hide");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /Most urgent/ }));
    expect(app.action).toHaveBeenLastCalledWith("pin", null);
  });

  it("names every chat choice by title, project, and an age ordinal for exact twins", async () => {
    const app = fixture();
    renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const project = "A very long project name that keeps going well past the chooser width";
    const chats = [
      chat("newer", "running", { chatTitle: "Fix login", projectName: "Alpha", since: "2026-09-06T10:05:00.000Z" }),
      chat("beta", "running", { chatTitle: "Fix login", projectName: "Beta" }),
      chat("older", "running", { chatTitle: "Fix login", projectName: "Alpha", since: "2026-09-06T10:00:00.000Z" }),
      chat("loose", "running", { chatTitle: "Fix login", projectName: null }),
      chat("long", "completed", { chatTitle: "Ship", projectName: project.slice(0, 64) }),
    ];
    app.list(chats[0]!, chats);
    fireEvent.click(screen.getByRole("button", { name: /Show chat/ }));
    const rows = within(screen.getByRole("group", { name: "Show chat" })).getAllByRole("button").slice(1);
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Fix login (2), Alpha, Working",
      "Fix login, Beta, Working",
      "Fix login (1), Alpha, Working",
      "Fix login, Working",
      `Ship, ${project.slice(0, 64)}, Done`,
    ]);
    expect(rows.map((row) => row.querySelector(".mascot-option-project")!.textContent)).toEqual(["Alpha", "Beta", "Alpha", "", project.slice(0, 64)]);
    expect(rows[0]!.querySelector(".mascot-option-title")).toHaveTextContent("Fix login (2)");
    expect(rows[4]!.title).toBe(`Ship — ${project.slice(0, 64)} — Work complete`);
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.click(rows[2]!);
    expect(app.action).toHaveBeenLastCalledWith("pin", "older");
  });

  it("keeps keyboard focus on a chooser row through every live list update", async () => {
    const app = fixture();
    renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => chat(id, "running"));
    app.list(a!, [a!, b!, c!, d!]);
    const picker = screen.getByRole("button", { name: /Show chat/ });
    fireEvent.click(picker);
    const group = screen.getByRole("group", { name: "Show chat" });
    const row = (key: string): HTMLElement => group.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
    const arrowsStillWork = (): void => {
      const start = document.activeElement;
      expect(group.contains(start)).toBe(true);
      fireEvent.keyDown(start!, { key: "ArrowDown" });
      expect(group.contains(document.activeElement)).toBe(true);
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(document.activeElement).toBe(start);
      expect(app.action).not.toHaveBeenCalledWith("down");
    };
    row("c").focus();
    app.list(a!, [c!, a!, b!, d!]);
    expect(document.activeElement).toBe(row("c"));
    arrowsStillWork();
    app.list(a!, [{ ...c!, phase: "completed", chatTitle: "Renamed chat" }, a!, b!, d!]);
    expect(document.activeElement).toBe(row("c"));
    expect(row("c")).toHaveAccessibleName(/Renamed chat/);
    arrowsStillWork();
    row("a").focus();
    app.list(c!, [c!, b!, d!]);
    expect(document.activeElement).toBe(row("b"));
    arrowsStillWork();
    const ranked = ["e", "f", "g", "h", "i"].map((id) => chat(id, "running"));
    app.list(c!, [c!, b!, d!, ...ranked]);
    row("i").focus();
    const urgent = chat("urgent", "waiting-for-input");
    app.list(urgent, [urgent, c!, b!, d!, ...ranked.slice(0, 4)]);
    expect(document.activeElement).toBe(row("h"));
    arrowsStillWork();
    app.list(emptyMascotStatus(), []);
    expect(picker).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(row(""));
    arrowsStillWork();
    app.list(a!, [a!, b!]);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    app.list(b!, [b!, a!]);
    expect(document.activeElement).toBe(outside);
    picker.focus();
    app.list(a!, [a!]);
    expect(document.activeElement).toBe(picker);
    fireEvent.click(picker);
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(picker.hidden).toBe(true);
    const open = screen.getByRole("button", { name: /Chat a/ });
    expect(document.activeElement).toBe(open);
    app.list(a!, [a!, b!]);
    expect(document.activeElement).toBe(open);
  });

  it("moves keyboard focus to the open button when choosing Auto hides the focused picker", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const a = chat("a", "running");
    app.list(a, [a], "a");
    const picker = view.container.querySelector<HTMLButtonElement>(".mascot-picker")!;
    expect(picker.hidden).toBe(false);
    picker.focus();
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("button", { name: /Most urgent/ }));
    expect(document.activeElement).toBe(picker);

    app.list(a, [a], null);

    expect(picker.hidden).toBe(true);
    expect(document.activeElement).toBe(view.container.querySelector(".mascot-open"));
  });

  it.each([
    ["ArrowUp", "c"],
    ["ArrowDown", ""],
  ] as const)("moves %s from the open chooser's picker to the edge row", async (key, expected) => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const [a, b, c] = ["a", "b", "c"].map((id) => chat(id, "running"));
    app.list(a!, [a!, b!, c!]);
    const picker = view.container.querySelector<HTMLButtonElement>(".mascot-picker")!;
    fireEvent.click(picker);
    picker.focus();

    fireEvent.keyDown(picker, { key });

    expect(document.activeElement).toBe(view.container.querySelector(`.mascot-option[data-key="${expected}"]`));
  });

  it("moves keyboard focus to the mascot when the hidden picker leaves no chat to open", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    app.list(emptyMascotStatus(), [], "gone");
    const picker = view.container.querySelector<HTMLButtonElement>(".mascot-picker")!;
    expect(picker.hidden).toBe(false);
    picker.focus();

    app.list(emptyMascotStatus(), [], null);

    expect(picker.hidden).toBe(true);
    expect(view.container.querySelector<HTMLButtonElement>(".mascot-open")).toBeDisabled();
    expect(document.activeElement).toBe(view.container.querySelector("main"));
  });

  it("states every count with its meaning and never announces more chats needing you than chats", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const detail = (): string => view.container.querySelector(".mascot-detail")!.textContent!;
    const picker = (): string => view.container.querySelector<HTMLElement>(".mascot-picker")!.getAttribute("aria-label")!;
    const bubble = (): string => view.container.querySelector<HTMLElement>(".mascot-open")!.getAttribute("aria-label")!;
    const announced = (): string => screen.getByRole("status").textContent!.replace(/\s+/gu, " ").trim();
    const flagged = (): string => view.container.querySelector<HTMLElement>(".mascot-picker")!.dataset.attention!;
    const waiting = Array.from({ length: 11 }, (_, index) => chat(`w${index}`, "waiting-for-input", { activeCount: 11, message: "Choose a scope" }));
    const done = chat("done", "completed", { activeCount: 11, message: "Shipped the fix" });
    const listed = [...waiting.slice(0, 7), done];
    app.list(done, listed, "done", { chats: 12, attention: 11 });
    expect(picker()).toBe("Show chat: pinned to Chat done. 12 chats, 11 need you");
    expect(detail()).toBe("11 other chats need you");
    expect(bubble()).toBe("Work complete. Chat done. Inertia. Shipped the fix. 11 other chats need you. View result ↗");
    expect(announced()).toBe("Work complete InertiaChat done Shipped the fix");
    expect(flagged()).toBe("true");
    app.list(waiting[0]!, waiting.slice(0, 8), null, { chats: 12, attention: 11 });
    expect(picker()).toBe("Show chat: most urgent. 12 chats, 11 need you");
    expect(detail()).toBe("10 other chats need you");
    app.list(waiting[0]!, waiting.slice(0, 8), null, { chats: 8, attention: 8 });
    expect(picker()).toBe("Show chat: most urgent. 8 chats, 8 need you");
    expect(detail()).toBe("7 other chats need you");
    app.list(done, [waiting[0]!, done], "done", { chats: 2, attention: 1 });
    expect(picker()).toBe("Show chat: pinned to Chat done. 2 chats, 1 needs you");
    expect(detail()).toBe("1 other chat needs you");
    app.list(done, listed, "done", { chats: 250, attention: 180 });
    expect(picker()).toBe("Show chat: pinned to Chat done. 99+ chats, 99+ need you");
    expect(detail()).toBe("99+ other chats need you");
    app.list(done, listed, "done");
    expect(picker()).toBe("Show chat: pinned to Chat done. 8+ chats, 7+ need you");
    expect(detail()).toBe("7+ other chats need you");
    app.list(done, [waiting[0]!, done], "done");
    expect(picker()).toBe("Show chat: pinned to Chat done. 2 chats, 1 needs you");
    expect(detail()).toBe("1 other chat needs you");
    const settled = { ...done, activeCount: 0 };
    app.list(settled, [settled, chat("quiet", "completed", { activeCount: 0 })], "done", { chats: 2, attention: 0 });
    expect(picker()).toBe("Show chat: pinned to Chat done. 2 chats");
    expect(detail()).toBe("");
    expect(flagged()).toBe("false");
  });
});

describe("mascot rendering", () => {
  it("renders an applied custom sprite set and returns to the bundled artwork on reset", async () => {
    const app = fixture();
    const view = renderMascot();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ready when you are"));
    const main = view.container.querySelector("main")!;
    const image = view.container.querySelector<HTMLImageElement>(".mascot-activity")!;
    const pickup = view.container.querySelector<HTMLImageElement>(".mascot-pickup")!;
    const bundled = image.getAttribute("src");
    expect(main.dataset.sprites).toBe("default");
    const url = (name: string): string => `inertia://bundle/mascot-sprites/0123456789abcdef/${name}`;
    const sprites: MascotSprites = {
      id: "0123456789abcdef", animated: 5,
      files: Object.fromEntries(MASCOT_SPRITE_STATES.map((state) => [state, { poster: url(`${state}.png`), animation: url(`${state}.webp`) }])) as MascotSprites["files"],
    };
    app.customize(sprites);
    expect(main.dataset.sprites).toBe("custom");
    expect(image.getAttribute("src")).toBe(url("idle.png"));
    expect(pickup.getAttribute("src")).toBe(url("pickup.png"));
    app.update("running");
    expect(image.getAttribute("src")).toBe(url("working.webp"));
    app.update("running", false);
    expect(image.getAttribute("src")).toBe(url("working.png"));
    app.update("waiting-for-input");
    app.interaction(true);
    expect(pickup.getAttribute("src")).toBe(url("pickup.webp"));
    app.interaction(false);
    expect(image.getAttribute("src")).toBe(url("thinking.webp"));
    app.update("idle");
    app.customize(undefined);
    expect(main.dataset.sprites).toBe("default");
    expect(image.getAttribute("src")).toBe(bundled);
  });

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
