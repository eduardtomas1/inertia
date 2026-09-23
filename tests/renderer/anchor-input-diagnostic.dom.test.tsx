import { afterEach, describe, expect, it, vi } from "vitest";
import { observeAnchorInput } from "../e2e/support/anchor-input-diagnostic";

function editor(): HTMLTextAreaElement {
  document.body.innerHTML = `<div class="app-shell" data-connection-status="online">
    <section class="composer" aria-label="Message composer" data-primary-action="send-disabled"
      data-disabled="false" aria-busy="false">
      <textarea aria-label="Message"></textarea>
      <button aria-label="Send message" disabled aria-busy="false"></button>
      <div class="provider-readiness" data-transient="true" data-route-repair="refresh"></div>
    </section><textarea aria-label="Unrelated"></textarea></div>`;
  return document.querySelector("textarea")!;
}

afterEach(() => {
  observeAnchorInput({ action: "dispose" });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("scenario-owned anchor input observations", () => {
  it("retains only eight redacted events and whitelisted readiness fields", () => {
    const textarea = editor();
    const secret = "private-draft-sentinel";
    observeAnchorInput({ action: "install", expectedValue: secret });
    textarea.value = secret;
    textarea.focus();
    for (let index = 0; index < 20; index++) {
      textarea.dispatchEvent(new Event(index % 2 ? "change" : "input", { bubbles: true }));
    }
    const result = observeAnchorInput({ action: "read" }) as { events: unknown[] };
    expect(result.events).toHaveLength(8);
    expect(result).toMatchObject({ inputCount: 10, changeCount: 10, state: {
      valueLength: secret.length, valueMatches: true, textareaFocused: true,
      initialTextareaConnected: true, sameTextarea: true,
      primaryAction: "send-disabled", sendDisabled: true, sendBusy: false,
      readinessPresent: true, readinessTransient: true, routeRepair: "refresh", connection: "online",
    } });
    expect(JSON.stringify(result)).not.toContain(secret);
    document.querySelector<HTMLElement>(".composer")!.dataset.primaryAction = secret;
    document.querySelector<HTMLElement>(".provider-readiness")!.dataset.routeRepair = secret;
    document.querySelector<HTMLElement>(".app-shell")!.dataset.connectionStatus = secret;
    expect(observeAnchorInput({ action: "read" })).toMatchObject({ state: {
      primaryAction: null, routeRepair: null, connection: null,
    } });
    expect(JSON.stringify(observeAnchorInput({ action: "read" }))).not.toContain(secret);
  });

  it("distinguishes replaced or missing inputs and ignores unrelated events", () => {
    const initial = editor();
    observeAnchorInput({ action: "install", expectedValue: "fixture" });
    document.querySelector('[aria-label="Unrelated"]')!
      .dispatchEvent(new Event("input", { bubbles: true }));
    const next = initial.cloneNode() as HTMLTextAreaElement;
    initial.replaceWith(next);
    next.value = "fixture";
    next.dispatchEvent(new Event("input", { bubbles: true }));
    expect(observeAnchorInput({ action: "read" })).toMatchObject({ inputCount: 1, state: {
      initialTextareaConnected: false, sameTextarea: false, valueMatches: true,
    } });
    next.remove();
    expect(observeAnchorInput({ action: "read" })).toMatchObject({ state: {
      textareaPresent: false, valueLength: null, valueMatches: null,
    } });
  });

  it("removes the old listeners on disposal and reinstall", () => {
    const textarea = editor();
    observeAnchorInput({ action: "install" });
    const old = Reflect.get(window, "__inertiaAnchorInputDiagnostic") as { read(): unknown };
    observeAnchorInput({ action: "install" });
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(old.read()).toMatchObject({ inputCount: 0 });
    const current = Reflect.get(window, "__inertiaAnchorInputDiagnostic") as { read(): unknown };
    observeAnchorInput({ action: "dispose" });
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(current.read()).toMatchObject({ inputCount: 1, changeCount: 0 });
    expect(observeAnchorInput({ action: "read" })).toBeNull();
  });

  it.each([true, false])("bounds the heartbeat when a frame arrives: %s", async (responds) => {
    vi.useFakeTimers();
    let callback: FrameRequestCallback | undefined;
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (next: FrameRequestCallback) => { callback = next; return 7; });
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const result = observeAnchorInput({ action: "heartbeat" });
    if (responds) callback!(0);
    else await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(responds ? "frame" : "no-frame");
    expect(vi.getTimerCount()).toBe(0);
    if (!responds) expect(cancel).toHaveBeenCalledWith(7);
  });
});
