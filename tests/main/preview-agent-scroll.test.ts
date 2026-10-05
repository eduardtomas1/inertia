import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { describeAgentPageRef, scrollAgentPageRefIntoView } from "../../src/main/preview-agent-scroll";

function control(tagName: string, attributes: Record<string, string>, text = "") {
  return {
    tagName, isConnected: true, textContent: text, labels: [], type: attributes.type ?? "",
    getAttribute: (name: string) => attributes[name] ?? null,
    scrollIntoView: vi.fn(),
  };
}

function page(element: ReturnType<typeof control>, state: Record<string, unknown> = {}) {
  const context = {
    __inertiaAgentBrowser: {
      privacyGuardInstalled: true, refs: new Map([["e1", element]]),
      passwordNodes: new WeakSet(), passwordValues: new Set(), ...state,
    },
    innerWidth: 1_280, innerHeight: 800, scrollX: 0, scrollY: 640,
  };
  return {
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: Array<{ code: string }>) => (
      runInNewContext(scripts[0]!.code, context)
    )),
  };
}

describe("Browser scroll targets", () => {
  it("names a control for its scroll approval without exposing a secret field", async () => {
    await expect(describeAgentPageRef(page(control("BUTTON", { "aria-label": "Delete account" })) as never, "e1"))
      .resolves.toMatchObject({ found: true, role: "button", label: "Delete account" });
    await expect(describeAgentPageRef(page(control("INPUT", { type: "password" })) as never, "e1"))
      .resolves.toMatchObject({ found: true, label: "Sensitive field", sensitive: true });
    await expect(describeAgentPageRef(page(control("BUTTON", {}, "Pay now"), { evidenceWithheld: "hidden-input" }) as never, "e1"))
      .resolves.toMatchObject({ found: true, label: "Sensitive field" });
    await expect(describeAgentPageRef(page(control("BUTTON", {})) as never, "e9")).resolves.toEqual({ found: false });
  });

  it("scrolls instantly even when the page asks for smooth scrolling", async () => {
    const element = control("BUTTON", {});
    await expect(scrollAgentPageRefIntoView(page(element) as never, "e1"))
      .resolves.toEqual({ found: true, viewport: { width: 1_280, height: 800, scrollX: 0, scrollY: 640 } });
    expect(element.scrollIntoView).toHaveBeenCalledWith({ behavior: "instant", block: "center", inline: "nearest" });
  });
});
