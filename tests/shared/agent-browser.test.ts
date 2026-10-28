import { describe, expect, it } from "vitest";

import {
  AGENT_BROWSER_FAILURE_CODES,
  AGENT_BROWSER_INPUT_BUDGET_MS,
  AGENT_BROWSER_INSPECT_BUDGET_MS,
  AGENT_BROWSER_NAVIGATION_BUDGET_MS,
  AGENT_BROWSER_QUEUE_WAIT_MS,
  AGENT_BROWSER_RUNTIME_BACKSTOP_MS,
  MAX_AGENT_BROWSER_IMAGE_BYTES,
  MAX_AGENT_BROWSER_TEXT_BYTES,
  MAX_AGENT_BROWSER_WAIT_MS,
  agentBrowserTextLength,
  parseAgentBrowserCommand,
  parseAgentBrowserResult,
  parseAgentBrowserViewport,
  parseAgentBrowserViewportRequest,
} from "../../src/shared/agent-browser";

const tabId = "11111111-1111-4111-8111-111111111111";
const state = {
  activeTabId: tabId,
  tabs: [{ id: tabId, title: "Local app", url: "http://127.0.0.1:3000/", loading: false }],
  activity: null,
};

describe("agent browser boundary", () => {
  it("accepts only exact bounded commands", () => {
    expect(parseAgentBrowserCommand({ action: "type", ref: "e12", text: "hello", replace: true }))
      .toEqual({ action: "type", ref: "e12", text: "hello", replace: true });
    expect(parseAgentBrowserCommand({ action: "scroll", deltaY: 2_000 }))
      .toEqual({ action: "scroll", deltaY: 2_000 });
    expect(parseAgentBrowserCommand({ action: "type", ref: "e12", text: "x", replace: true, path: "/tmp" }))
      .toBeNull();
    expect(parseAgentBrowserCommand({ action: "click", ref: "e12;document.cookie" }))
      .toBeNull();
    expect(parseAgentBrowserCommand({ action: "press", key: "Meta+A" }))
      .toBeNull();
    for (const key of ["Shift+Tab", "Shift+Enter", "Control+Enter", "Meta+Enter", "Home", "End", "PageUp", "PageDown"]) {
      expect(parseAgentBrowserCommand({ action: "press", key })).toEqual({ action: "press", key });
    }
    expect(parseAgentBrowserCommand({ action: "press", key: "Control+Tab" })).toBeNull();
    for (const direction of ["back", "forward", "reload"]) {
      expect(parseAgentBrowserCommand({ action: "history", direction })).toEqual({ action: "history", direction });
    }
    expect(parseAgentBrowserCommand({ action: "history", direction: "home" })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "click", ref: "e1", dialog: "accept" }))
      .toEqual({ action: "click", ref: "e1", dialog: "accept" });
    expect(parseAgentBrowserCommand({ action: "press", key: "Enter", dialog: "accept" }))
      .toEqual({ action: "press", key: "Enter", dialog: "accept" });
    expect(parseAgentBrowserCommand({ action: "click", ref: "e1", dialog: "dismiss" }))
      .toEqual({ action: "click", ref: "e1" });
    expect(parseAgentBrowserCommand({ action: "click", ref: "e1", dialog: "yes" })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "type", ref: "e1", text: "a", replace: true, dialog: "accept" }))
      .toBeNull();
    expect(parseAgentBrowserCommand({ action: "history", direction: "back", url: "http://localhost:3000" }))
      .toBeNull();
    expect(parseAgentBrowserCommand({ action: "scroll", deltaY: 2_001 }))
      .toBeNull();
    expect(parseAgentBrowserCommand({ action: "scroll", ref: "e4" })).toEqual({ action: "scroll", ref: "e4" });
    expect(parseAgentBrowserCommand({ action: "scroll", ref: "e4", deltaY: 10 })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "scroll" })).toBeNull();
  });

  it("accepts only exact bounded wait commands", () => {
    expect(parseAgentBrowserCommand({ action: "wait", state: "present", timeoutMs: 10_000 }))
      .toEqual({ action: "wait", state: "present", timeoutMs: 10_000 });
    expect(parseAgentBrowserCommand({ action: "wait", text: "Saved", state: "absent", timeoutMs: 250 }))
      .toEqual({ action: "wait", text: "Saved", state: "absent", timeoutMs: 250 });
    for (const invalid of [
      { action: "wait", state: "present" },
      { action: "wait", state: "visible", timeoutMs: 1_000 },
      { action: "wait", state: "present", timeoutMs: 249 },
      { action: "wait", state: "present", timeoutMs: 30_001 },
      { action: "wait", state: "present", timeoutMs: 1_000.5 },
      { action: "wait", text: "", state: "present", timeoutMs: 1_000 },
      { action: "wait", text: "   ", state: "present", timeoutMs: 1_000 },
      { action: "wait", text: "two\nlines", state: "present", timeoutMs: 1_000 },
      { action: "wait", text: "x".repeat(201), state: "present", timeoutMs: 1_000 },
      { action: "wait", text: "Saved", state: "present", timeoutMs: 1_000, url: "/done" },
    ]) expect(parseAgentBrowserCommand(invalid), JSON.stringify(invalid)).toBeNull();
  });

  it("counts command text lengths in Unicode code points", () => {
    const emoji = "\u{1F600}";
    expect(agentBrowserTextLength(emoji.repeat(3))).toBe(3);
    expect(agentBrowserTextLength("\uD83D\uD83Dx\uDE00")).toBe(4);
    expect(parseAgentBrowserCommand({ action: "type", ref: "e1", text: emoji.repeat(4_000), replace: true }))
      .not.toBeNull();
    expect(parseAgentBrowserCommand({ action: "type", ref: "e1", text: emoji.repeat(4_001), replace: true }))
      .toBeNull();
    expect(parseAgentBrowserCommand({ action: "wait", text: emoji.repeat(200), state: "present", timeoutMs: 1_000 }))
      .not.toBeNull();
    expect(parseAgentBrowserCommand({ action: "wait", text: emoji.repeat(201), state: "present", timeoutMs: 1_000 }))
      .toBeNull();
    const url = `http://localhost:3000/${emoji.repeat(4_096 - 22)}`;
    expect(parseAgentBrowserCommand({ action: "navigate", url })).not.toBeNull();
    expect(parseAgentBrowserCommand({ action: "navigate", url: `${url}x` })).toBeNull();
  });

  it("carries every failure code across the process boundary and rejects unknown ones", () => {
    expect(AGENT_BROWSER_FAILURE_CODES).toEqual([
      "cancelled", "interrupted", "invalid", "not-found", "sensitive", "timeout", "too-large", "unavailable",
    ]);
    for (const code of AGENT_BROWSER_FAILURE_CODES) {
      expect(parseAgentBrowserResult({ ok: false, code, message: "Explained." }))
        .toEqual({ ok: false, code, message: "Explained." });
    }
    expect(parseAgentBrowserResult({ ok: false, code: "blocked", message: "Explained." })).toBeNull();
    expect(parseAgentBrowserResult({ ok: false, code: "timeout", message: "" })).toBeNull();
    expect(parseAgentBrowserResult({ ok: false, code: "timeout", message: "Explained.", retry: true }))
      .toBeNull();
    expect(parseAgentBrowserResult({ ok: false, code: "timeout", message: "Explained.", reachedPage: true }))
      .toEqual({ ok: false, code: "timeout", message: "Explained.", reachedPage: true });
    expect(parseAgentBrowserResult({ ok: false, code: "timeout", message: "Explained.", reachedPage: "yes" }))
      .toBeNull();
  });

  it("keeps the runtime backstop above every deadline the main process enforces", () => {
    expect(AGENT_BROWSER_RUNTIME_BACKSTOP_MS).toBeGreaterThan(
      AGENT_BROWSER_QUEUE_WAIT_MS + Math.max(
        AGENT_BROWSER_NAVIGATION_BUDGET_MS,
        AGENT_BROWSER_INPUT_BUDGET_MS,
        AGENT_BROWSER_INSPECT_BUDGET_MS,
        MAX_AGENT_BROWSER_WAIT_MS + 5_000,
      ),
    );
  });

  it("accepts only exact bounded viewport and interaction commands", () => {
    expect(parseAgentBrowserCommand({ action: "resize", preset: "desktop" }))
      .toEqual({ action: "resize", preset: "desktop" });
    expect(parseAgentBrowserCommand({ action: "resize", width: 1_440, height: 900 }))
      .toEqual({ action: "resize", width: 1_440, height: 900 });
    expect(parseAgentBrowserCommand({ action: "resize", colorScheme: "dark" }))
      .toEqual({ action: "resize", colorScheme: "dark" });
    expect(parseAgentBrowserCommand({ action: "resize", preset: "mobile", colorScheme: "light" }))
      .toEqual({ action: "resize", preset: "mobile", colorScheme: "light" });
    expect(parseAgentBrowserCommand({ action: "resize" })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "resize", preset: "desktop", width: 1_280, height: 800 })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "resize", width: 1_280 })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "resize", width: 319, height: 800 })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "resize", width: 1_280, height: 2_561 })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "resize", width: 1_280.5, height: 800 })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "resize", preset: "phone" })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "resize", colorScheme: "auto" })).toBeNull();
    expect(parseAgentBrowserViewportRequest({ preset: "fit" })).toEqual({ preset: "fit" });
    expect(parseAgentBrowserViewportRequest({ width: 320, height: 240 })).toEqual({ width: 320, height: 240 });
    expect(parseAgentBrowserViewportRequest({ preset: "fit", width: 320, height: 240 })).toBeNull();
    expect(parseAgentBrowserViewportRequest({ width: 2_561, height: 240 })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "hover", ref: "e3" })).toEqual({ action: "hover", ref: "e3" });
    expect(parseAgentBrowserCommand({ action: "hover", ref: "e3", dialog: "accept" })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "select", ref: "e3", value: "eu-west" }))
      .toEqual({ action: "select", ref: "e3", value: "eu-west" });
    expect(parseAgentBrowserCommand({ action: "select", ref: "e3", value: "" })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "select", ref: "e3", value: "a\nb" })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "select", ref: "e3", value: "x".repeat(201) })).toBeNull();
    expect(parseAgentBrowserCommand({ action: "logs" })).toEqual({ action: "logs" });
    expect(parseAgentBrowserCommand({ action: "logs", tabId })).toBeNull();
  });
  it("carries a bounded PNG image and viewport across the process boundary", () => {
    const image = Buffer.from("small-png-fixture!!").toString("base64");
    const viewport = { width: 1_280, height: 800, fit: false, mobile: false, colorScheme: "system" };
    expect(parseAgentBrowserResult({
      ok: true,
      text: "screenshot",
      state: { ...state, viewport },
      image: { mimeType: "image/png", data: image, width: 1_280, height: 800 },
    })).toEqual({
      ok: true,
      text: "screenshot",
      state: { ...state, viewport },
      image: { mimeType: "image/png", data: image, width: 1_280, height: 800 },
    });
    expect(parseAgentBrowserResult({
      ok: true,
      text: "screenshot",
      state,
      image: { mimeType: "image/png", data: image },
    })).toBeNull();
    expect(parseAgentBrowserResult({
      ok: true,
      text: "screenshot",
      state,
      image: { mimeType: "image/png", data: image, width: 1_569, height: 800 },
    })).toBeNull();
    expect(parseAgentBrowserResult({
      ok: true,
      text: "screenshot",
      state,
      image: { mimeType: "image/png", data: "not base64!", width: 10, height: 10 },
    })).toBeNull();
    expect(parseAgentBrowserResult({
      ok: true,
      text: "screenshot",
      state,
      image: { mimeType: "image/png", data: "A".repeat(Math.ceil(MAX_AGENT_BROWSER_IMAGE_BYTES / 3) * 4 + 4), width: 10, height: 10 },
    })).toBeNull();
    expect(parseAgentBrowserResult({ ok: true, text: "snapshot", state: { ...state, viewport: { ...viewport, fit: "yes" } } }))
      .toBeNull();
    expect(parseAgentBrowserViewport(viewport)).toEqual(viewport);
    expect(parseAgentBrowserViewport({ ...viewport, colorScheme: "auto" })).toBeNull();
  });
  it("strictly bounds semantic text and tab state while rejecting bitmap bytes", () => {
    const image = Buffer.from("small-png-fixture!!").toString("base64");
    expect(parseAgentBrowserResult({ ok: true, text: "snapshot", state: { ...state, tabs: [] } }))
      .toBeNull();
    expect(parseAgentBrowserResult({ ok: true, text: "snapshot", state: { ...state, controller: "user" } }))
      .toEqual({ ok: true, text: "snapshot", state: { ...state, controller: "user" } });
    expect(parseAgentBrowserResult({ ok: true, text: "snapshot", state: { ...state, controller: "agent" } }))
      .toBeNull();
    expect(parseAgentBrowserResult({
      ok: true,
      text: "é".repeat(Math.floor(MAX_AGENT_BROWSER_TEXT_BYTES / 2) + 1),
      state,
    })).toBeNull();
    expect(parseAgentBrowserResult({
      ok: true,
      text: "snapshot",
      state,
      image: { mimeType: "image/jpeg", data: image, width: 10, height: 10 },
    })).toBeNull();
  });
});
