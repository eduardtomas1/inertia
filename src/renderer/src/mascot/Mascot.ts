import {
  emptyMascotStatus, MASCOT_LABELS,
  type MascotAction, type MascotBridge, type MascotGesture, type MascotSnapshot,
} from "../../../shared/mascot";
import { mascotArtwork, readMascotAssets } from "./assets";
import { mascotActionLabel, mascotFallback } from "./copy";

declare global { interface Window { mascot: MascotBridge } }

/** An event-driven image and label: no framework, frame loop, or status polling. */
export function mountMascot(root: HTMLElement, bridge: MascotBridge): () => void {
  const mascotAssets = readMascotAssets(root);
  const select = <T extends HTMLElement = HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const main = select("main");
  const image = select<HTMLImageElement>("img");
  const pickupImage = select<HTMLImageElement>(".mascot-pickup");
  const handle = select(".mascot-drag");
  const button = select<HTMLButtonElement>("button");
  const label = select(".mascot-label");
  const detail = select(".mascot-detail");
  const chat = select(".mascot-chat");
  const message = select(".mascot-message");
  const actionLabel = select(".mascot-action");
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  const listeners = new AbortController();
  const eventOptions = { signal: listeners.signal };
  let snapshot: MascotSnapshot = {
    status: emptyMascotStatus("unavailable"), preferences: { enabled: false, motion: false },
  };
  let active = true;
  let received = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointer: number | null = null;
  let gesture: MascotGesture = [0, 0];

  const render = (): void => {
    const { status, preferences } = snapshot;
    const moving = preferences.enabled && preferences.motion && !document.hidden && !media.matches;
    const dragging = Boolean(snapshot.dragging);
    const animated = moving && !dragging
      && !settled && (status.activeCount > 0 || status.phase === "completed");
    const src = mascotAssets[mascotArtwork(status.phase)][animated ? "animation" : "poster"];
    if (image.getAttribute("src") !== src) image.setAttribute("src", src);
    image.dataset.animated = String(animated);
    const pickup = mascotAssets.pickup[moving && dragging ? "animation" : "poster"];
    if (pickupImage.getAttribute("src") !== pickup) pickupImage.setAttribute("src", pickup);
    pickupImage.dataset.animated = String(moving && dragging);
    main.dataset.dragging = String(dragging);
    main.dataset.motion = String(moving);
    main.dataset.placement = snapshot.placement ?? "manual";
    main.dataset.phase = status.phase;
    label.textContent = MASCOT_LABELS[status.phase];
    button.disabled = !status.conversationId;
    chat.textContent = status.chatTitle ?? "Inertia";
    message.textContent = status.message ?? mascotFallback[status.phase];
    actionLabel.textContent = status.conversationId ? mascotActionLabel(status.phase) : "";
    detail.textContent = status.progress ?? (status.activeCount > 1 ? `${status.activeCount} active chats` : "");
    button.setAttribute("aria-label", [label.textContent, chat.textContent, message.textContent, detail.textContent, actionLabel.textContent].filter(Boolean).join(". "));
    button.title = `${chat.textContent}\n${message.textContent}\n${status.activeCount > 1 ? `${status.activeCount} active chats. ` : ""}${actionLabel.textContent}`;
  };
  const update = (value: MascotSnapshot): void => {
    if (!active) return;
    if (value.gesture) {
      if (value.gesture[0] !== gesture[0] || value.gesture[1] > gesture[1]) gesture = value.gesture;
      if (!value.dragging && value.gesture[0] === gesture[0] && value.gesture[1] === gesture[1]) releasePointer();
    }
    if (snapshot.status.phase !== value.status.phase || snapshot.status.turnId !== value.status.turnId) {
      clearTimeout(timer);
      settled = false;
      // Idea is a looping export. Limit the cue to one 3-second clip per turn.
      if (value.status.phase === "completed") timer = setTimeout(() => { settled = true; render(); }, 3_000);
    }
    snapshot = value;
    render();
  };
  const perform = (action: MascotAction): void => {
    const expected = action === "open-chat" ? snapshot.status : action === "drop" ? gesture : undefined;
    const operation = expected ? bridge.action(action, expected) : bridge.action(action);
    void operation.catch(() => { if (active) label.textContent = "Open Inertia to continue"; });
  };
  const open = (): void => perform("open-chat");
  const focus = (): void => { main.dataset.keyboardFocus = "true"; main.focus(); };
  const releasePointer = (): void => {
    const previous = pointer;
    pointer = null;
    if (previous !== null && handle.hasPointerCapture(previous)) handle.releasePointerCapture(previous);
  };
  const drop = (): void => {
    if (pointer === null) return;
    releasePointer();
    perform("drop");
  };
  const pickup = (event: PointerEvent): void => {
    if (!snapshot.preferences.enabled || snapshot.placement === "system" || event.button !== 0 || !event.isPrimary || event.pointerType !== "mouse" || pointer !== null) return;
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch { return; }
    pointer = event.pointerId;
    const current = gesture = [gesture[0], gesture[1] + 1];
    void bridge.action("pickup", current).catch(() => {
      if (gesture === current) { releasePointer(); if (active) label.textContent = "Use Settings to move with keyboard"; }
    });
  };
  const pointerEnd = (event: PointerEvent): void => { if (event.pointerId === pointer) drop(); };
  const pointerMove = (event: PointerEvent): void => { if (event.pointerId === pointer && !(event.buttons & 1)) drop(); };
  const visibility = (): void => { if (document.hidden) drop(); render(); };
  const blur = (): void => { delete main.dataset.keyboardFocus; drop(); };
  const key = (event: KeyboardEvent): void => {
    const actions: Record<string, MascotAction> = {
      ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Escape: "hide",
    };
    const action = actions[event.key];
    if (action) { event.preventDefault(); perform(action); }
  };
  const unsubscribe = bridge.onChanged((value) => { received = true; update(value); });
  void bridge.snapshot().then((value) => { if (!received) update(value); })
    .catch(() => { if (active) label.textContent = "Open Inertia to continue"; });
  main.addEventListener("keydown", key, eventOptions);
  button.addEventListener("click", open, eventOptions);
  handle.addEventListener("pointerdown", pickup, eventOptions);
  handle.addEventListener("lostpointercapture", pointerEnd, eventOptions);
  window.addEventListener("pointerup", pointerEnd, eventOptions);
  window.addEventListener("pointercancel", pointerEnd, eventOptions);
  window.addEventListener("pointermove", pointerMove, eventOptions);
  document.addEventListener("visibilitychange", visibility, eventOptions);
  media.addEventListener("change", render, eventOptions);
  window.addEventListener("focus", focus, eventOptions);
  window.addEventListener("blur", blur, eventOptions);
  render();
  // Set the keyboard target without requesting native window activation.
  main.focus({ preventScroll: true });
  return () => {
    active = false;
    listeners.abort();
    drop();
    clearTimeout(timer);
    unsubscribe();
  };
}
