import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { allowedSubframeUrl, guardFramedPages } from "../../src/main/frame-navigation-policy";

const RENDER_ID = "55555555-5555-4555-8555-555555555555";

describe("subframe navigation policy", () => {
  it("allows only a visual reply on the application scheme", () => {
    expect(allowedSubframeUrl("inertia", `inertia://render/${RENDER_ID}`)).toBe(true);
    expect(allowedSubframeUrl("inertia", `inertia://render/${RENDER_ID}#theme=%7B%7D`)).toBe(true);
    expect(allowedSubframeUrl("inertia-canary", `inertia-canary://render/${RENDER_ID}`)).toBe(true);
  });

  it.each([
    ["the renderer bundle", "inertia://bundle/index.html"],
    ["an attachment preview", `inertia://bundle/attachment-preview/${RENDER_ID}`],
    ["http", `http://render/${RENDER_ID}`],
    ["https", "https://example.com/"],
    ["another host", `inertia://bundles/${RENDER_ID}`],
    ["another scheme", `inertia-canary://render/${RENDER_ID}`],
    ["path traversal", `inertia://render/../bundle/${RENDER_ID}`],
    ["encoded traversal", "inertia://render/%2e%2e/bundle/index.html"],
    ["an encoded separator", `inertia://render/%2e%2e%2f${RENDER_ID}`],
    ["a nested path", `inertia://render/${RENDER_ID}/index.html`],
    ["a malformed id", "inertia://render/not-a-render"],
    ["an empty path", "inertia://render/"],
    ["a query string", `inertia://render/${RENDER_ID}?x=1`],
    ["userinfo", `inertia://user@render/${RENDER_ID}`],
    ["a port", `inertia://render:8080/${RENDER_ID}`],
    ["data", "data:text/html,<p>hi</p>"],
    ["javascript", "javascript:alert(1)"],
    ["about", "about:blank"],
    ["garbage", "not a url"],
  ])("denies %s", (_label, url) => {
    expect(allowedSubframeUrl("inertia", url)).toBe(false);
  });

  it("prevents denied subframe navigations and leaves the main frame alone", () => {
    const contents = Object.assign(new EventEmitter(), { setWebRTCIPHandlingPolicy: vi.fn() });
    guardFramedPages(contents as unknown as WebContents, "inertia");
    const navigate = (url: string, isMainFrame: boolean) => {
      const details = { url, isMainFrame, preventDefault: vi.fn() };
      contents.emit("will-frame-navigate", details);
      return details.preventDefault;
    };
    expect(navigate(`inertia://render/${RENDER_ID}`, false)).not.toHaveBeenCalled();
    expect(navigate("https://example.com/", false)).toHaveBeenCalledOnce();
    expect(navigate("inertia://bundle/index.html", false)).toHaveBeenCalledOnce();
    expect(navigate("https://example.com/", true)).not.toHaveBeenCalled();
  });

  it("keeps WebRTC from opening direct UDP connections", () => {
    const contents = Object.assign(new EventEmitter(), { setWebRTCIPHandlingPolicy: vi.fn() });
    guardFramedPages(contents as unknown as WebContents, "inertia");
    expect(contents.setWebRTCIPHandlingPolicy).toHaveBeenCalledExactlyOnceWith("disable_non_proxied_udp");
  });
});
