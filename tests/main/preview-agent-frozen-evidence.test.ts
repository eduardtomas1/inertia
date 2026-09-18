import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { installAgentFileChooserBlock, setAgentPageFrozen } from "../../src/main/preview-agent-boundary";
import { ensureAgentFileChooserBlock, resetAgentFileChooserBlock } from "../../src/main/preview-agent-input";
import {
  agentPageHasSensitiveEvidence,
  agentPageHasSensitiveScreenshotEvidence,
  semanticPageSnapshot,
} from "../../src/main/preview-agent-page";

const WORLD_UNAVAILABLE = "The Browser privacy world is unavailable for this page.";
const pageUrl = "http://127.0.0.1:8091/";
const privacyWorld = {
  id: 7,
  name: "Electron Isolated Context",
  auxData: { frameId: "main", isDefault: false, type: "isolated" },
};
const mainWorld = {
  id: 1,
  name: "",
  auxData: { frameId: "main", isDefault: true, type: "default" },
};

type DebuggerListener = (event: unknown, method: string, params: unknown) => void;

function diagnosticDocument(): Record<string, unknown> {
  const input = {
    nodeType: 1,
    tagName: "INPUT",
    type: "text",
    value: "example",
    labels: [],
    firstChild: null,
    parentElement: null,
    disabled: false,
    checked: false,
    getAttribute: (name: string) => name === "aria-label" ? "Test note" : null,
    hasAttribute: () => false,
    matches: () => false,
    getBoundingClientRect: () => ({
      x: 10, y: 10, left: 10, top: 10, right: 210, bottom: 40, width: 200, height: 30,
    }),
  };
  const body = { tagName: "BODY", parentElement: null } as Record<string, unknown>;
  body.firstChild = {
    nodeType: 3, parentElement: body, parentNode: body, nodeValue: "Local browser diagnostic", nextSibling: null,
  };
  return {
    title: "Local browser diagnostic",
    body,
    documentElement: {},
    getElementById: () => null,
    createNodeIterator: () => {
      const nodes = [input];
      let index = 0;
      return { nextNode: () => nodes[index++] ?? null };
    },
  };
}

function worldGlobals(guardInstalled: boolean): Record<string, unknown> {
  return {
    __inertiaAgentBrowser: guardInstalled ? {
      privacyGuardInstalled: true,
      nestedContentObserved: false,
      passwordNodes: new WeakSet(),
      passwordValues: new Set(),
      nodes: new WeakMap(),
      refs: new Map(),
      next: 1,
    } : undefined,
    document: diagnosticDocument(),
    location: { href: pageUrl },
    URL,
    encodeURIComponent,
    innerWidth: 1_200,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  };
}

function chromiumPage(contexts: Array<Record<string, unknown>> = [mainWorld, privacyWorld]) {
  let frozen = false;
  let heldRuntimeEnable: (() => void) | null = null;
  const holdRuntimeEnable = { next: false };
  const strandRuntimeEnable = { next: false };
  const failPageEnable = { next: false };
  let runtimeEnabled = false;
  const listeners = new Set<DebuggerListener>();
  const worlds = new Map<number, Record<string, unknown>>([
    [privacyWorld.id, worldGlobals(true)],
    [mainWorld.id, worldGlobals(false)],
  ]);
  const emit = (method: string, params: unknown): void => {
    for (const listener of listeners) listener({}, method, params);
  };
  const debuggerApi = {
    attached: false,
    attach: vi.fn(() => { debuggerApi.attached = true; }),
    detach: vi.fn(() => { debuggerApi.attached = false; }),
    isAttached: () => debuggerApi.attached,
    on: (name: string, listener: DebuggerListener) => {
      if (name === "message") listeners.add(listener);
    },
    removeListener: (name: string, listener: DebuggerListener) => {
      if (name === "message") listeners.delete(listener);
    },
    sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Page.enable" && failPageEnable.next) {
        failPageEnable.next = false;
        throw new Error("Page.enable failed");
      }
      if (method === "Page.setWebLifecycleState") {
        frozen = params.state === "frozen";
        return {};
      }
      if (method === "Runtime.disable") {
        runtimeEnabled = false;
        return {};
      }
      if (method === "Runtime.enable") {
        if (holdRuntimeEnable.next) {
          holdRuntimeEnable.next = false;
          await new Promise<void>((resolve) => { heldRuntimeEnable = resolve; });
        }
        if (!runtimeEnabled) {
          runtimeEnabled = true;
          for (const context of contexts) emit("Runtime.executionContextCreated", { context });
        }
        if (strandRuntimeEnable.next) {
          strandRuntimeEnable.next = false;
          return await new Promise<never>(() => undefined);
        }
        return {};
      }
      if (method === "Runtime.evaluate") {
        const world = worlds.get(params.contextId as number);
        if (!world) throw new Error("Cannot find context with specified id");
        try {
          const value = runInNewContext(String(params.expression), world) as unknown;
          return { result: value === undefined ? { type: "undefined" } : { value: JSON.parse(JSON.stringify(value)) as unknown } };
        } catch {
          return { result: { type: "object" }, exceptionDetails: { text: "Uncaught" } };
        }
      }
      return {};
    }),
  };
  const contents = {
    debugger: debuggerApi,
    getURL: () => pageUrl,
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(async (_worldId: number, scripts: Array<{ code: string }>) => (
      frozen
        ? await new Promise<never>(() => undefined)
        : runInNewContext(scripts[0]!.code, worlds.get(privacyWorld.id)!) as unknown
    )),
  };
  return {
    contents,
    debuggerApi,
    emit,
    failPageEnable,
    holdRuntimeEnable,
    isFrozen: () => frozen,
    listenerCount: () => listeners.size,
    releaseRuntimeEnable: () => heldRuntimeEnable?.(),
    strandRuntimeEnable,
    world: (id: number) => worlds.get(id)!,
  };
}

async function attachedPage(contexts?: Array<Record<string, unknown>>) {
  const page = chromiumPage(contexts);
  await installAgentFileChooserBlock(page.contents as never);
  page.emit("Page.frameNavigated", { frame: { id: "main", url: pageUrl } });
  return page;
}

async function withinFreeze<Result>(operation: Promise<Result>): Promise<Result> {
  return await Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("The evidence check stalled behind the frozen page.")), 250);
    }),
  ]);
}

describe("frozen Browser evidence", () => {
  it("keeps privacy evidence running in the preload world while Chromium holds the page frozen", async () => {
    const page = await attachedPage();
    const contents = page.contents as never;

    await setAgentPageFrozen(contents, true);
    expect(page.isFrozen()).toBe(true);
    await expect(withinFreeze(agentPageHasSensitiveEvidence(contents))).resolves.toBe(false);
    const snapshot = JSON.parse(await withinFreeze(semanticPageSnapshot(contents))) as {
      title: string;
      elements: Array<Record<string, unknown>>;
    };
    expect(snapshot.title).toBe("Local browser diagnostic");
    expect(snapshot.elements).toEqual([expect.objectContaining({ ref: "e1" })]);
    expect(JSON.stringify(snapshot.elements)).toContain("Test note");
    await expect(withinFreeze(agentPageHasSensitiveScreenshotEvidence(contents))).resolves.toBe(false);
    expect(page.contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    const evaluations = page.debuggerApi.sendCommand.mock.calls
      .filter(([method]) => method === "Runtime.evaluate")
      .map(([, params]) => params);
    expect(evaluations.length).toBeGreaterThan(3);
    for (const params of evaluations) {
      expect(params).toMatchObject({ contextId: privacyWorld.id, returnByValue: true, userGesture: false });
    }
    expect(page.listenerCount()).toBe(1);

    await setAgentPageFrozen(contents, false);
    expect(page.isFrozen()).toBe(false);
    await expect(agentPageHasSensitiveEvidence(contents)).resolves.toBe(false);
    expect(page.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledOnce();
  });

  it.each([
    ["no preload world", [mainWorld]],
    ["an ambiguous preload world", [mainWorld, privacyWorld, { ...privacyWorld, id: 8 }]],
    ["a preload world of another frame", [{ ...privacyWorld, auxData: { ...privacyWorld.auxData, frameId: "child" } }]],
    ["a lookalike world without the privacy guard", [{ ...privacyWorld, id: mainWorld.id }]],
    ["a default world with the preload name", [{ ...privacyWorld, auxData: { ...privacyWorld.auxData, isDefault: true } }]],
  ])("refuses to freeze with %s", async (_label, contexts) => {
    const page = await attachedPage(contexts);

    await expect(setAgentPageFrozen(page.contents as never, true)).rejects.toThrow(WORLD_UNAVAILABLE);
    expect(page.isFrozen()).toBe(false);
    expect(page.debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Page.setWebLifecycleState",
      { state: "frozen" },
    );
    expect(page.debuggerApi.sendCommand).toHaveBeenCalledWith("Runtime.disable");
  });

  it("fails closed when the frozen document is replaced or its privacy check throws", async () => {
    const page = await attachedPage();
    const contents = page.contents as never;

    await setAgentPageFrozen(contents, true);
    page.emit("Page.frameNavigated", { frame: { id: "main", url: `${pageUrl}next` } });
    await expect(agentPageHasSensitiveEvidence(contents)).rejects.toThrow(
      "The Browser page changed while it was frozen for evidence capture.",
    );
    await setAgentPageFrozen(contents, false);

    await setAgentPageFrozen(contents, true);
    (page.world(privacyWorld.id).__inertiaAgentBrowser as { privacyGuardInstalled: boolean })
      .privacyGuardInstalled = false;
    await expect(agentPageHasSensitiveEvidence(contents)).rejects.toThrow(
      "The Browser privacy check failed while the page was frozen.",
    );
    await setAgentPageFrozen(contents, false);
    expect(page.isFrozen()).toBe(false);
  });

  it("never lets a superseded freeze land after the page resumed", async () => {
    const page = await attachedPage();
    const contents = page.contents as never;
    page.holdRuntimeEnable.next = true;

    const freezing = setAgentPageFrozen(contents, true);
    await vi.waitFor(() => expect(page.debuggerApi.sendCommand).toHaveBeenCalledWith("Runtime.enable"));
    await setAgentPageFrozen(contents, false);
    page.releaseRuntimeEnable();

    await expect(freezing).rejects.toThrow("The Browser evidence freeze was superseded.");
    expect(page.isFrozen()).toBe(false);
    expect(page.debuggerApi.sendCommand).not.toHaveBeenCalledWith(
      "Page.setWebLifecycleState",
      { state: "frozen" },
    );
    await expect(agentPageHasSensitiveEvidence(contents)).resolves.toBe(false);
  });

  it("recovers the preload world after a context lookup whose response never arrived", async () => {
    const page = await attachedPage();
    const contents = page.contents as never;
    page.strandRuntimeEnable.next = true;

    const stranded = setAgentPageFrozen(contents, true);
    void stranded.catch(() => undefined);
    await vi.waitFor(() => expect(page.listenerCount()).toBe(2));
    await setAgentPageFrozen(contents, false);

    await setAgentPageFrozen(contents, true);
    expect(page.isFrozen()).toBe(true);
    expect(page.listenerCount()).toBe(1);
    await expect(withinFreeze(agentPageHasSensitiveEvidence(contents))).resolves.toBe(false);
    await setAgentPageFrozen(contents, false);
    expect(page.isFrozen()).toBe(false);
  });

  it("retries a failed security debugger setup and releases a reset debugger completely", async () => {
    const page = chromiumPage();
    const contents = page.contents as never;
    page.failPageEnable.next = true;

    await expect(ensureAgentFileChooserBlock(contents)).rejects.toThrow("Page.enable failed");
    expect(page.debuggerApi.attached).toBe(false);
    expect(page.listenerCount()).toBe(0);
    await expect(ensureAgentFileChooserBlock(contents)).resolves.toBeUndefined();
    expect(page.debuggerApi.attach).toHaveBeenCalledTimes(2);
    expect(page.listenerCount()).toBe(1);

    resetAgentFileChooserBlock(contents);
    expect(page.debuggerApi.attached).toBe(false);
    expect(page.listenerCount()).toBe(0);
    await expect(setAgentPageFrozen(contents, true)).rejects.toThrow(
      "The Browser security debugger is unavailable.",
    );
    await expect(ensureAgentFileChooserBlock(contents)).resolves.toBeUndefined();
    page.emit("Page.frameNavigated", { frame: { id: "main", url: pageUrl } });
    await setAgentPageFrozen(contents, true);
    await expect(withinFreeze(agentPageHasSensitiveEvidence(contents))).resolves.toBe(false);
    await setAgentPageFrozen(contents, false);
  });
});
