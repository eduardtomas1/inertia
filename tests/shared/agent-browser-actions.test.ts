import { describe, expect, it } from "vitest";

import {
  AGENT_BROWSER_ACTION_KINDS,
  agentBrowserKeyChord,
  agentBrowserModifiers,
  agentBrowserPathMatches,
  parseAgentBrowserCommand,
  parseAgentBrowserResult,
} from "../../src/shared/agent-browser";
import { parseAgentBrowserRequest } from "../../src/shared/agent-browser-approval";

describe("agent browser pointer and key commands at the process boundary", () => {
  it.each([
    [{ action: "click", ref: "e1", clickCount: 2 }, { action: "click", ref: "e1", clickCount: 2 }],
    [{ action: "click", ref: "e1", clickCount: 3, dialog: "accept" }, { action: "click", ref: "e1", clickCount: 3, dialog: "accept" }],
    [{ action: "click", ref: "e1", clickCount: 1, modifiers: [] }, { action: "click", ref: "e1" }],
    [{ action: "click", ref: "e1", modifiers: ["Shift", "Control"] }, { action: "click", ref: "e1", modifiers: ["Control", "Shift"] }],
    [{ action: "press", key: "Home", modifiers: ["Meta", "Shift"] }, { action: "press", key: "Home", modifiers: ["Shift", "Meta"] }],
    [{ action: "scroll", deltaX: -40 }, { action: "scroll", deltaX: -40 }],
    [{ action: "scroll", deltaX: 2_000, deltaY: -2_000 }, { action: "scroll", deltaX: 2_000, deltaY: -2_000 }],
    [{ action: "scroll", deltaY: 1 }, { action: "scroll", deltaY: 1 }],
    [{ action: "drag", ref: "e1", targetRef: "e2" }, { action: "drag", ref: "e1", targetRef: "e2" }],
    [
      { action: "wait", path: "/orders/*", ref: "e3", state: "absent", timeoutMs: 250 },
      { action: "wait", path: "/orders/*", ref: "e3", state: "absent", timeoutMs: 250 },
    ],
  ])("accepts %j", (command, parsed) => {
    expect(parseAgentBrowserCommand(command)).toEqual(parsed);
    expect(parseAgentBrowserRequest({ action: "prepare-approval", command })).toEqual({ action: "prepare-approval", command: parsed });
  });

  it.each([
    { action: "click", ref: "e1", clickCount: 0 },
    { action: "click", ref: "e1", clickCount: 4 },
    { action: "click", ref: "e1", clickCount: 2.5 },
    { action: "click", ref: "e1", clickCount: "2" },
    { action: "click", ref: "e1", modifiers: ["Shift", "Shift"] },
    { action: "click", ref: "e1", modifiers: ["shift"] },
    { action: "click", ref: "e1", modifiers: "Shift" },
    { action: "click", ref: "e1", button: "right" },
    { action: "click", x: 10, y: 20 },
    { action: "press", key: "Enter", modifiers: ["Fn"] },
    { action: "press", key: "a", modifiers: ["Control"] },
    { action: "scroll" },
    { action: "scroll", deltaX: 0 },
    { action: "scroll", deltaX: 10, deltaY: 0 },
    { action: "scroll", deltaX: 2_001 },
    { action: "scroll", deltaX: 1.5 },
    { action: "scroll", deltaX: 10, ref: "e1" },
    { action: "drag", ref: "e1" },
    { action: "drag", ref: "e1", targetRef: "e1" },
    { action: "drag", ref: "e1", targetRef: "e 2" },
    { action: "drag", ref: "e1", targetRef: "e2", steps: 10 },
    { action: "wait", path: "orders", state: "present", timeoutMs: 250 },
    { action: "wait", path: "/orders?id=1", state: "present", timeoutMs: 250 },
    { action: "wait", path: "/orders#list", state: "present", timeoutMs: 250 },
    { action: "wait", path: "/ord*", state: "present", timeoutMs: 250 },
    { action: "wait", path: "/a\nb", state: "present", timeoutMs: 250 },
    { action: "wait", path: `/${"x".repeat(200)}`, state: "present", timeoutMs: 250 },
    { action: "wait", ref: "bad ref", state: "present", timeoutMs: 250 },
    { action: "wait", selector: "#save", state: "present", timeoutMs: 250 },
  ])("rejects %j", (command) => {
    expect(parseAgentBrowserCommand(command)).toBeNull();
  });

  it("reports drag activity across the process boundary", () => {
    const tabId = "11111111-1111-4111-8111-111111111111";
    expect(AGENT_BROWSER_ACTION_KINDS).toContain("drag");
    const result = {
      ok: true,
      text: "{}",
      state: {
        activeTabId: tabId,
        tabs: [{ id: tabId, title: "Local page", url: "http://127.0.0.1:3000", loading: false }],
        activity: { action: "drag", label: "Agent dragged a page element", tabId, at: new Date(0).toISOString(), x: 1, y: 2 },
      },
    };
    expect(parseAgentBrowserResult(result)).toEqual(result);
  });

  it("orders held keys canonically and merges a chord key's own modifier", () => {
    expect(agentBrowserModifiers(["Meta", "Alt", "Shift", "Control"])).toEqual(["Control", "Alt", "Shift", "Meta"]);
    expect(agentBrowserModifiers([])).toEqual([]);
    expect(agentBrowserModifiers(["Alt", "Alt"])).toBeNull();
    expect(agentBrowserKeyChord("Tab")).toEqual({ key: "Tab", modifiers: [], label: "Tab" });
    expect(agentBrowserKeyChord("Shift+Tab", ["Control", "Shift"]))
      .toEqual({ key: "Tab", modifiers: ["Control", "Shift"], label: "Control+Shift+Tab" });
    expect(agentBrowserKeyChord("Meta+Enter", ["Alt"]))
      .toEqual({ key: "Enter", modifiers: ["Alt", "Meta"], label: "Alt+Meta+Enter" });
  });
});

describe("agent browser wait paths", () => {
  it.each([
    ["http://127.0.0.1:3000/", "/", true],
    ["http://127.0.0.1:3000/orders", "/orders", true],
    ["http://127.0.0.1:3000/orders/", "/orders", true],
    ["http://127.0.0.1:3000/orders", "/orders/", true],
    ["http://127.0.0.1:3000/orders/42?token=secret#part", "/orders/*", true],
    ["http://127.0.0.1:3000/orders/42/edit", "/orders/*/edit", true],
    ["http://127.0.0.1:3000/caf%C3%A9", "/café", true],
    ["http://localhost:5173/orders", "/orders", true],
    ["http://127.0.0.1:3000/orders/42", "/orders", false],
    ["http://127.0.0.1:3000/orders", "/orders/*", false],
    ["http://127.0.0.1:3000/orders//edit", "/orders/*/edit", false],
    ["http://127.0.0.1:3000/Orders", "/orders", false],
    ["http://127.0.0.1:3000/orders-archive", "/orders", false],
    ["http://127.0.0.1:3000/", "/*", false],
    ["http://127.0.0.1:3000/reset?token=abc", "/reset?token=abc", false],
    ["http://127.0.0.1:3000/reset/abcdef", "/reset/abc*", false],
    ["about:blank", "/", false],
    ["not a url", "/", false],
  ])("%s has path %s: %s", (url, path, matches) => {
    expect(agentBrowserPathMatches(url, path)).toBe(matches);
  });
});
