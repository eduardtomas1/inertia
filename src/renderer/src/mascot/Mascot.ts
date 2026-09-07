import {
  emptyMascotStatus, MASCOT_LABELS,
  type MascotAction, type MascotBridge, type MascotSnapshot,
} from "../../../shared/mascot";
import { mascotArtwork, mascotAssets } from "./assets";
import { mascotActionLabel, mascotFallback } from "./copy";

declare global { interface Window { mascot: MascotBridge } }

/** An event-driven image and label: no framework, frame loop, or status polling. */
export function mountMascot(root: HTMLElement, bridge: MascotBridge): () => void {
  // All interpolated runtime content is assigned through textContent below.
  root.innerHTML = `<main class="mascot" tabindex="0">
    <div class="mascot-speech-dots" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="mascot-drag" title="Drag to move. Right-click for options.">
      <img class="mascot-activity" width="96" height="96" alt="" draggable="false" />
      <img class="mascot-pickup" width="96" height="96" alt="" draggable="false" />
    </div>
    <button class="mascot-status" type="button" title="Open chat. Arrow keys move the mascot; Escape hides it.">
      <span class="mascot-content" role="status" aria-live="polite" aria-atomic="true">
        <span class="mascot-label"></span>
        <span class="mascot-chat"></span>
        <span class="mascot-message"></span>
      </span>
      <span class="mascot-footer"><span class="mascot-detail"></span><span class="mascot-action"></span></span>
    </button>
  </main>`;
  const main = root.querySelector("main")!;
  const image = root.querySelector("img")!;
  const pickupImage = root.querySelector<HTMLImageElement>(".mascot-pickup")!;
  const handle = root.querySelector<HTMLElement>(".mascot-drag")!;
  const button = root.querySelector("button")!;
  const label = root.querySelector(".mascot-label")!;
  const detail = root.querySelector(".mascot-detail")!;
  const chat = root.querySelector(".mascot-chat")!;
  const message = root.querySelector(".mascot-message")!;
  const actionLabel = root.querySelector(".mascot-action")!;
  const media = matchMedia("(prefers-reduced-motion: reduce)");
  let snapshot: MascotSnapshot = {
    status: emptyMascotStatus("unavailable"), preferences: { enabled: false, motion: false },
  };
  let active = true;
  let received = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointer: number | null = null;

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
    if (snapshot.dragging && !value.dragging) releasePointer();
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
    const operation = action === "open-chat" ? bridge.action(action, snapshot.status) : bridge.action(action);
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
    if (snapshot.placement === "system" || event.button !== 0 || !event.isPrimary || event.pointerType !== "mouse" || pointer !== null) return;
    event.preventDefault();
    try { handle.setPointerCapture(event.pointerId); } catch { return; }
    pointer = event.pointerId;
    void bridge.action("pickup").catch(() => { releasePointer(); if (active) label.textContent = "Use Settings to move with keyboard"; });
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
  main.addEventListener("keydown", key);
  button.addEventListener("click", open);
  handle.addEventListener("pointerdown", pickup);
  handle.addEventListener("lostpointercapture", pointerEnd);
  window.addEventListener("pointerup", pointerEnd);
  window.addEventListener("pointercancel", pointerEnd);
  window.addEventListener("pointermove", pointerMove);
  document.addEventListener("visibilitychange", visibility);
  media.addEventListener("change", render);
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  render();
  // Set the keyboard target without requesting native window activation.
  main.focus({ preventScroll: true });
  return () => {
    active = false;
    drop();
    clearTimeout(timer);
    unsubscribe();
    main.removeEventListener("keydown", key);
    button.removeEventListener("click", open);
    handle.removeEventListener("pointerdown", pickup);
    handle.removeEventListener("lostpointercapture", pointerEnd);
    window.removeEventListener("pointerup", pointerEnd);
    window.removeEventListener("pointercancel", pointerEnd);
    window.removeEventListener("pointermove", pointerMove);
    document.removeEventListener("visibilitychange", visibility);
    media.removeEventListener("change", render);
    window.removeEventListener("focus", focus);
    window.removeEventListener("blur", blur);
  };
}
