import {
  emptyMascotStatus, isLiveMascotPhase, MASCOT_CHAT_LIMIT, MASCOT_COMPACT_HEIGHT, MASCOT_LABELS, mascotBubbleHeight,
  type MascotAction, type MascotBridge, type MascotGesture, type MascotSnapshot, type MascotStatus,
} from "../../../shared/mascot";
import { mascotChatChoices } from "../../../shared/mascot-choices";
import { mascotArtwork, readMascotAssets } from "./assets";
import { mascotActionLabel, mascotElapsed, mascotRowState, mascotShortLabel, mascotTone } from "./copy";

declare global { interface Window { mascot: MascotBridge } }

/** An event-driven image and label: no framework, frame loop, or status polling. */
export function mountMascot(root: HTMLElement, bridge: MascotBridge): () => void {
  const mascotAssets = readMascotAssets(root);
  const select = <T extends HTMLElement = HTMLElement>(selector: string): T => root.querySelector<T>(selector)!;
  const main = select("main");
  const image = select<HTMLImageElement>("img");
  const pickupImage = select<HTMLImageElement>(".mascot-pickup");
  const handle = select(".mascot-drag");
  const bubble = select(".mascot-status");
  const button = select<HTMLButtonElement>(".mascot-open");
  const label = select(".mascot-label");
  const time = select(".mascot-time");
  const detail = select(".mascot-detail");
  const project = select(".mascot-project");
  const title = select(".mascot-title");
  const message = select(".mascot-message");
  const actionLabel = select(".mascot-action");
  const steps = select(".mascot-steps");
  const stepsFill = select(".mascot-steps i");
  const picker = select<HTMLButtonElement>(".mascot-picker");
  const pickerLabel = select(".mascot-picker-label");
  const chooser = select(".mascot-chooser");
  const list = select(".mascot-chats");
  const rowList = select(".mascot-rows");
  const more = select(".mascot-more");
  const announcer = select(".mascot-announce");
  const options = new Map<string, HTMLButtonElement>();
  const rows = new Map<string, HTMLButtonElement>();
  let announced = "";
  let reported = 0;
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
  let clock: ReturnType<typeof setTimeout> | undefined;
  let pointer: number | null = null;
  let gesture: MascotGesture = [0, 0];
  let choosing = false;

  const option = (key: string): HTMLButtonElement => {
    let row = options.get(key);
    if (!row) {
      row = document.createElement("button");
      row.type = "button";
      row.className = "mascot-option";
      row.dataset.key = key;
      row.append(...["mascot-dot", "mascot-option-title", "mascot-option-project", "mascot-option-state"].map((name) => {
        const part = document.createElement("span");
        part.className = name;
        return part;
      }));
      row.firstElementChild!.setAttribute("aria-hidden", "true");
      row.addEventListener("click", () => choose(key || null), eventOptions);
      options.set(key, row);
    }
    return row;
  };
  const renderChats = (chats: readonly MascotStatus[], pinned: string | null): void => {
    const focusedIndex = [...list.children].indexOf(document.activeElement!);
    const focusedKey = focusedIndex < 0 ? undefined : (document.activeElement as HTMLElement).dataset.key!;
    const choices = mascotChatChoices(chats);
    const rows = [["", null, null] as const, ...chats.map((chat, index) => [chat.conversationId!, chat, choices[index]!] as const)].map(([key, chat, choice]) => {
      const row = option(key);
      const [dot, name, project, state] = row.children as unknown as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
      row.setAttribute("aria-pressed", String(key ? key === pinned : !pinned));
      row.dataset.tone = chat ? mascotTone(chat.phase) : "auto";
      dot.dataset.tone = row.dataset.tone;
      name.textContent = choice?.title ?? "Most urgent chat";
      project.textContent = choice?.project ?? "";
      state.textContent = chat ? mascotShortLabel[chat.phase] : "Auto";
      row.setAttribute("aria-label", [name.textContent, project.textContent, state.textContent].filter(Boolean).join(", "));
      row.title = chat ? [choice!.title, choice!.project, MASCOT_LABELS[chat.phase]].filter(Boolean).join(" — ")
        : "Follow whichever chat needs you most";
      return row;
    });
    for (const key of options.keys()) if (!rows.some((row) => row.dataset.key === key)) options.delete(key);
    rows.forEach((row, index) => { if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null); });
    while (list.children.length > rows.length) list.lastElementChild!.remove();
    const target = focusedKey === undefined ? undefined : options.get(focusedKey) ?? rows[Math.min(focusedIndex, rows.length - 1)];
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  };

  const renderRows = (chats: readonly MascotStatus[], others: number): void => {
    const choices = mascotChatChoices(chats);
    const items = chats.map((chat, index) => {
      const key = chat.conversationId!;
      let row = rows.get(key);
      if (!row) {
        row = document.createElement("button");
        row.type = "button";
        row.className = "mascot-row";
        row.append(document.createElement("span"), document.createElement("span"));
        row.addEventListener("click", () => {
          const target = snapshot.rows?.find((candidate) => candidate.conversationId === key);
          if (target) void bridge.action("open-chat", target).catch(() => { if (active) label.textContent = "That chat changed. Try again"; });
        }, eventOptions);
        rows.set(key, row);
      }
      const [name, state] = row.children as unknown as [HTMLElement, HTMLElement];
      const word = mascotRowState(chat);
      name.textContent = choices[index]!.title;
      state.textContent = `· ${word}`;
      row.dataset.tone = mascotTone(chat.phase);
      row.setAttribute("aria-label", `Open ${name.textContent}, ${word}`);
      return row;
    });
    for (const key of rows.keys()) if (!chats.some(({ conversationId }) => conversationId === key)) rows.delete(key);
    items.forEach((row, index) => { if (rowList.children[index] !== row) rowList.insertBefore(row, rowList.children[index] ?? null); });
    while (rowList.children.length > items.length + 1) rowList.children[items.length]!.remove();
    more.textContent = others > chats.length ? `${others - chats.length} more` : "";
    more.hidden = !more.textContent;
    rowList.hidden = !items.length;
  };

  const render = (): void => {
    const { status, preferences } = snapshot;
    const chats = snapshot.chats ?? [];
    const pinned = snapshot.pinned ?? null;
    const live = isLiveMascotPhase(status.phase);
    const moving = preferences.enabled && preferences.motion && !document.hidden && !media.matches;
    const dragging = Boolean(snapshot.dragging);
    const animated = moving && !dragging
      && !settled && (live || status.phase === "completed");
    const artwork = snapshot.sprites?.files ?? mascotAssets;
    const src = artwork[mascotArtwork(status.phase)][animated ? "animation" : "poster"];
    if (image.getAttribute("src") !== src) image.setAttribute("src", src);
    image.dataset.animated = String(animated);
    const pickup = artwork.pickup[moving && dragging ? "animation" : "poster"];
    if (pickupImage.getAttribute("src") !== pickup) pickupImage.setAttribute("src", pickup);
    pickupImage.dataset.animated = String(moving && dragging);
    main.dataset.dragging = String(dragging);
    main.dataset.motion = String(moving);
    main.dataset.placement = snapshot.placement ?? "manual";
    main.dataset.sprites = snapshot.sprites ? "custom" : "default";
    main.dataset.phase = status.phase;
    main.dataset.tone = mascotTone(status.phase);
    main.dataset.pinned = String(Boolean(pinned));
    main.dataset.artwork = mascotArtwork(status.phase);
    main.dataset.compact = String(!status.conversationId && !choosing);
    label.textContent = status.quietSince ? `No updates for ${mascotElapsed(status.quietSince, Date.now(), true)}` : MASCOT_LABELS[status.phase];
    time.textContent = status.since ? mascotElapsed(status.since, Date.now(), live) : "";
    button.disabled = !status.conversationId;
    project.textContent = status.projectName ?? "";
    title.textContent = status.chatTitle ?? "Inertia";
    message.textContent = status.message ?? "";
    actionLabel.textContent = status.conversationId ? mascotActionLabel(status.phase) : "";
    const exact = Boolean(snapshot.counts) || chats.length < MASCOT_CHAT_LIMIT;
    const total = snapshot.counts?.chats ?? chats.length;
    const attention = snapshot.counts?.attention ?? chats.filter((chat) => mascotTone(chat.phase) === "attention").length;
    const others = Math.max(0, attention - (status.conversationId && mascotTone(status.phase) === "attention" ? 1 : 0));
    const amount = (count: number): string => count > 99 ? "99+" : `${count}${exact ? "" : "+"}`;
    const counted = (count: number, one: string, many: string): string => `${amount(count)} ${count === 1 && exact ? one : many}`;
    const plan = mascotTone(status.phase) === "live" ? status.steps : null;
    steps.hidden = !plan;
    if (plan) stepsFill.style.setProperty("--mascot-steps", String(plan.completed / plan.total));
    detail.textContent = plan ? `${plan.completed} of ${plan.total} steps` : status.progress ?? "";
    button.setAttribute("aria-label", [label.textContent, time.textContent, title.textContent, project.textContent, message.textContent, detail.textContent, actionLabel.textContent].filter(Boolean).join(". "));
    button.title = `${[title.textContent, project.textContent].filter(Boolean).join(" — ")}\n${message.textContent}\n${actionLabel.textContent}`;
    const shownRows = snapshot.rows ?? [];
    const otherCount = snapshot.counts?.others ?? shownRows.length;
    renderRows(shownRows, otherCount);
    const height = main.dataset.compact === "true" ? MASCOT_COMPACT_HEIGHT : mascotBubbleHeight(shownRows.length, otherCount);
    bubble.style.height = `${height}px`;
    if (height !== reported && active) {
      reported = height;
      void bridge.action("bubble", height).catch(() => { reported = 0; });
    }
    const attentionNow = mascotTone(status.phase) === "attention";
    const announcement = [label.textContent, status.conversationId ? title.textContent : "", attentionNow ? status.message : ""].filter(Boolean).join(". ");
    const key = `${status.phase}\u0000${status.conversationId}\u0000${attentionNow ? status.message : ""}\u0000${Boolean(status.quietSince)}`;
    if (key !== announced) { announced = key; announcer.textContent = announcement; }
    const pickerFocused = document.activeElement === picker;
    picker.hidden = !choosing && !pinned && chats.every((chat) => chat.conversationId === status.conversationId);
    picker.dataset.attention = String(others > 0);
    pickerLabel.textContent = pinned ? "Pinned" : "Auto";
    picker.title = "Choose which chat the mascot shows";
    picker.setAttribute("aria-label", `Show chat: ${pinned ? `pinned to ${title.textContent}` : "most urgent"}. ${counted(total, "chat", "chats")}${attention ? `, ${counted(attention, "needs", "need")} you` : ""}`);
    picker.setAttribute("aria-expanded", String(choosing));
    bubble.dataset.view = choosing ? "chats" : "status";
    button.hidden = choosing;
    rowList.hidden ||= choosing;
    chooser.hidden = !choosing;
    if (pickerFocused && picker.hidden) (button.disabled ? main : button).focus({ preventScroll: true });
    if (choosing) renderChats(chats, pinned);
    clearTimeout(clock);
    if (status.since && active && !document.hidden) {
      const age = Date.now() - Date.parse(status.since);
      clock = setTimeout(render, 60_250 - (((age % 60_000) + 60_000) % 60_000));
    }
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
  const toggle = (): void => {
    choosing = !choosing;
    render();
    if (choosing) (options.get(snapshot.pinned ?? "") ?? options.get(""))?.focus({ preventScroll: true });
  };
  const choose = (conversationId: string | null): void => {
    const focused = chooser.contains(document.activeElement);
    choosing = false;
    render();
    if (focused) picker.focus({ preventScroll: true });
    void bridge.action("pin", conversationId).catch(() => { if (active) label.textContent = "That chat changed. Try again"; });
  };
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
      ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
    };
    if (choosing && ["ArrowUp", "ArrowDown", "Escape"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Escape") { toggle(); picker.focus({ preventScroll: true }); return; }
      const rows = [...list.children] as HTMLElement[];
      const index = rows.indexOf(document.activeElement as HTMLElement);
      const next = index < 0
        ? event.key === "ArrowUp" ? rows.length - 1 : 0
        : (index + (event.key === "ArrowUp" ? rows.length - 1 : 1)) % rows.length;
      rows[next]?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      delete main.dataset.keyboardFocus;
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    const action = actions[event.key];
    if (action) { event.preventDefault(); perform(action); }
  };
  const unsubscribe = bridge.onChanged((value) => { received = true; update(value); });
  void bridge.snapshot().then((value) => { if (!received) update(value); })
    .catch(() => { if (active) label.textContent = "Open Inertia to continue"; });
  main.addEventListener("keydown", key, eventOptions);
  button.addEventListener("click", open, eventOptions);
  picker.addEventListener("click", toggle, eventOptions);
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
    clearTimeout(clock);
    unsubscribe();
  };
}
