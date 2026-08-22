import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_BROWSER_SCREENSHOT_BYTES,
  parseAgentBrowserCommand,
  parseAgentBrowserResult,
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
    expect(parseAgentBrowserCommand({ action: "scroll", deltaY: 2_001 }))
      .toBeNull();
  });

  it("strictly bounds semantic text, tab state, and PNG evidence", () => {
    const image = Buffer.from("small-png-fixture").toString("base64");
    expect(parseAgentBrowserResult({
      ok: true,
      text: "snapshot",
      state,
      image: { mimeType: "image/png", data: image },
    })).toEqual({
      ok: true,
      text: "snapshot",
      state,
      image: { mimeType: "image/png", data: image },
    });
    expect(parseAgentBrowserResult({ ok: true, text: "snapshot", state: { ...state, tabs: [] } }))
      .toBeNull();
    expect(parseAgentBrowserResult({
      ok: true,
      text: "snapshot",
      state,
      image: { mimeType: "image/jpeg", data: image },
    })).toBeNull();
    expect(parseAgentBrowserResult({
      ok: true,
      text: "snapshot",
      state,
      image: {
        mimeType: "image/png",
        data: Buffer.alloc(MAX_AGENT_BROWSER_SCREENSHOT_BYTES + 1).toString("base64"),
      },
    })).toBeNull();
  });
});
