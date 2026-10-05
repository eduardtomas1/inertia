import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { semanticPageSnapshot, serializeAgentPageSnapshot } from "../../src/main/preview-agent-page";
import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../../src/shared/agent-browser";

interface Snapshot {
  text: string;
  elements: Array<{ ref?: string; name?: string; offscreen?: boolean }>;
  omitted?: { textChars: number; elements: number };
  nextStep?: string;
  dialogs?: unknown[];
}

const base = {
  title: "Local page",
  url: "http://127.0.0.1:3000",
  viewport: { width: 1_200, height: 800, scrollX: 0, scrollY: 0 },
};

function button(name: string, y: number) {
  const attributes: Record<string, string> = { "aria-label": name };
  const node: Record<string, unknown> = {
    nodeType: 1, tagName: "BUTTON", firstChild: null, parentElement: null, labels: [],
    readOnly: false, disabled: false, isConnected: true, isContentEditable: false,
    getAttribute: (key: string) => attributes[key] ?? null,
    hasAttribute: (key: string) => Object.hasOwn(attributes, key),
    matches: () => false,
    getBoundingClientRect: () => ({ x: 10, y, left: 10, top: y, right: 110, bottom: y + 30, width: 100, height: 30 }),
  };
  node.contains = (candidate: unknown) => candidate === node;
  return node;
}

async function pageSnapshot(elements: readonly unknown[]): Promise<Snapshot> {
  const body = { firstChild: null as unknown, parentElement: null, tagName: "BODY" };
  body.firstChild = { nodeType: 3, nodeValue: "Page", parentElement: body, parentNode: body, nextSibling: null };
  const context = {
    document: {
      title: "Long page", body, documentElement: {},
      createNodeIterator: () => {
        let index = 0;
        return { nextNode: () => elements[index++] ?? null };
      },
    },
    location: { href: "http://127.0.0.1:3000/long", protocol: "http:" }, URL, encodeURIComponent,
    innerWidth: 1_200, innerHeight: 800, scrollX: 0, scrollY: 0,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  };
  const contents = {
    executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, scripts: Array<{ code: string }>) => (
      runInNewContext(scripts[0]!.code, context)
    )),
  };
  return JSON.parse(await semanticPageSnapshot(contents as never)) as Snapshot;
}

describe("snapshot omissions the agent can act on", () => {
  it("reports nothing omitted for a page read completely", () => {
    const parsed = JSON.parse(serializeAgentPageSnapshot({ ...base, text: "Hi", elements: [], truncated: false })) as Snapshot;
    expect(parsed).not.toHaveProperty("omitted");
    expect(parsed).not.toHaveProperty("nextStep");
    expect(parsed).not.toHaveProperty("truncated");
  });

  it("counts left-out text and controls and says how to reach them", () => {
    const parsed = JSON.parse(serializeAgentPageSnapshot({
      ...base, text: "Hi", elements: [], truncated: true,
      omittedTextChars: 300, omittedElements: 4,
    })) as Snapshot;
    expect(parsed.omitted).toEqual({ textChars: 300, elements: 4 });
    expect(parsed.nextStep).toContain("inertia_browser_scroll");
    expect(parsed.nextStep).toContain("inertia_browser_wait_for");
    expect(parsed).not.toHaveProperty("truncated");
  });

  it("says when the page is larger than one snapshot reads even if nothing was counted", () => {
    const parsed = JSON.parse(serializeAgentPageSnapshot({
      ...base, text: "Hi", elements: [], truncated: true, readLimitReached: true,
    })) as Snapshot;
    expect(parsed.omitted).toEqual({ textChars: 0, elements: 0 });
    expect(parsed.nextStep).toContain("larger than one snapshot reads");
  });

  it("keeps the byte bound, counts what it drops, and keeps controls in the viewport before off-screen ones", () => {
    const elements = Array.from({ length: 200 }, (_, index) => ({
      ref: `e${index}`, role: "button", name: "界".repeat(300), disabled: false,
      rect: { x: 10, y: index < 100 ? 2_000 + index : index, width: 100, height: 30 },
      ...(index < 100 ? { offscreen: true } : {}),
    }));
    const serialized = serializeAgentPageSnapshot({
      ...base, text: "界".repeat(12_000), elements, truncated: false,
    }, { dialogs: [{ kind: "confirm", message: "Delete?", answer: "dismiss" }] });
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_AGENT_BROWSER_TEXT_BYTES);
    const parsed = JSON.parse(serialized) as Snapshot;
    expect(parsed.dialogs).toEqual([{ kind: "confirm", message: "Delete?", answer: "dismiss" }]);
    expect(parsed.elements.length).toBeGreaterThan(0);
    expect(parsed.elements.every((element) => element.offscreen !== true)).toBe(true);
    expect(parsed.omitted).toEqual({
      textChars: 12_000 - parsed.text.length,
      elements: 200 - parsed.elements.length,
    });
  });

  it("lists controls below the fold with refs and drops the farthest ones first", async () => {
    const elements = [
      button("Top", 10),
      ...Array.from({ length: 205 }, (_, index) => button(`Below ${index}`, 900 + index * 40)),
    ];
    const parsed = await pageSnapshot(elements);
    expect(parsed.elements.length).toBeGreaterThan(100);
    expect(parsed.elements.length).toBeLessThanOrEqual(200);
    expect(parsed.elements[0]).toMatchObject({ name: "Top", ref: expect.stringMatching(/^e\d+$/u) });
    expect(parsed.elements[0]).not.toHaveProperty("offscreen");
    expect(parsed.elements.slice(1).map((element) => element.name))
      .toEqual(Array.from({ length: parsed.elements.length - 1 }, (_, index) => `Below ${index}`));
    expect(parsed.elements.slice(1).every((element) => element.offscreen === true && Boolean(element.ref))).toBe(true);
    expect(parsed.omitted).toEqual({ textChars: 0, elements: 206 - parsed.elements.length });
  });
});
