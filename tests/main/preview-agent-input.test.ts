import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageActivationBlock,
  agentPageBoundaryGaps,
  beginAgentFileChooserBlock,
  ensureAgentFileChooserBlock,
  installAgentFileChooserBlock,
  releaseAgentFileChooserBlock,
  resetAgentFileChooserBlock,
  settleAgentPageInput,
} from "../../src/main/preview-agent-input";

describe("agent Browser structural boundaries", () => {
  function boundaryContents(
    focused: { subtype?: string; shadowRoots?: unknown } = {},
    url = "http://127.0.0.1:3000/",
  ) {
    const debuggerEvents = new EventEmitter();
    let attached = false;
    const sendCommand = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        return { result: { type: "object", subtype: focused.subtype ?? "node", objectId: "focused-element" } };
      }
      if (method === "DOM.describeNode") {
        return { node: { nodeType: 1, shadowRoots: focused.shadowRoots } };
      }
      return undefined;
    });
    const activationStates: Array<"disabled" | "file" | "nested" | null> = [];
    const contents = {
      debugger: Object.assign(debuggerEvents, {
        attach: vi.fn(() => { attached = true; }),
        detach: vi.fn(() => { attached = false; }),
        isAttached: vi.fn(() => attached),
        sendCommand,
      }),
      executeJavaScriptInIsolatedWorld: vi.fn(async () => activationStates.shift() ?? null),
      getURL: () => url,
      loadURL: vi.fn(async () => undefined),
      navigationHistory: {
        getActiveIndex: () => 0,
        getEntryAtIndex: () => ({ url }),
      },
    };
    return { activationStates, contents, debuggerEvents, sendCommand };
  }

  it("reports no gaps before a document or its boundaries are observed", () => {
    expect(agentPageBoundaryGaps({} as never)).toEqual({ frames: false, shadowRoots: false });
  });

  it("rechecks focused activation after the privileged focus check", async () => {
    const { activationStates, contents, debuggerEvents } = boundaryContents();
    activationStates.push(null, "disabled");
    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", { frame: { id: "main" } });

    await expect(agentPageActivationBlock(contents as never)).resolves.toBe("disabled");
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });

  it("tracks frames and shadow roots incrementally without serializing the page DOM", async () => {
    const { contents, debuggerEvents, sendCommand } = boundaryContents();

    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "main" },
    });
    expect(agentPageBoundaryGaps(contents as never)).toEqual({ frames: false, shadowRoots: false });

    debuggerEvents.emit("message", {}, "Page.frameAttached", {
      frameId: "child",
      parentFrameId: "main",
    });
    expect(agentPageBoundaryGaps(contents as never)).toEqual({ frames: true, shadowRoots: false });

    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "child", parentId: "main" },
    });
    expect(agentPageBoundaryGaps(contents as never)).toEqual({ frames: true, shadowRoots: false });

    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "next-main" },
    });
    expect(agentPageBoundaryGaps(contents as never)).toEqual({ frames: false, shadowRoots: false });

    debuggerEvents.emit("message", {}, "DOM.shadowRootPushed", {
      root: { shadowRootType: "user-agent" },
    });
    expect(agentPageBoundaryGaps(contents as never)).toEqual({ frames: false, shadowRoots: false });
    debuggerEvents.emit("message", {}, "DOM.shadowRootPushed", {
      root: { shadowRootType: "closed" },
    });
    expect(agentPageBoundaryGaps(contents as never)).toEqual({ frames: false, shadowRoots: true });
    expect(sendCommand).not.toHaveBeenCalledWith("Page.getFrameTree");
    expect(sendCommand).not.toHaveBeenCalledWith("DOMSnapshot.captureSnapshot", expect.anything());
    expect(sendCommand).not.toHaveBeenCalledWith("DOM.performSearch", expect.anything());
  });

  it("allows activation keys on pages that only contain frames or shadow roots elsewhere", async () => {
    const { contents, debuggerEvents, sendCommand } = boundaryContents({
      shadowRoots: [{ nodeType: 11, shadowRootType: "user-agent" }, { nodeType: 11, shadowRootType: "open" }],
    });
    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", { frame: { id: "main" } });
    debuggerEvents.emit("message", {}, "Page.frameAttached", { frameId: "child", parentFrameId: "main" });
    debuggerEvents.emit("message", {}, "DOM.shadowRootPushed", { root: { shadowRootType: "closed" } });

    await expect(agentPageActivationBlock(contents as never)).resolves.toBeNull();
    expect(sendCommand).toHaveBeenCalledWith("DOM.describeNode", {
      objectId: "focused-element",
      depth: 0,
      pierce: true,
    });
    expect(sendCommand).toHaveBeenCalledWith("Runtime.evaluate", expect.objectContaining({
      contextId: 9,
      returnByValue: false,
      timeout: 3_000,
    }));
    expect(sendCommand).toHaveBeenLastCalledWith("Runtime.releaseObjectGroup", {
      objectGroup: "inertia-agent-page-boundary",
    });
  });

  it.each([
    ["a closed shadow root owns focus", { shadowRoots: [{ nodeType: 11, shadowRootType: "closed" }] }],
    ["the focused shadow root has an unknown type", { shadowRoots: [{ nodeType: 11 }] }],
    ["the focused node description is malformed", { shadowRoots: "closed" }],
    ["the focused element cannot be resolved", { subtype: "null" }],
  ])("refuses activation keys when %s", async (_label, focused) => {
    const { contents, debuggerEvents } = boundaryContents(focused);
    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", { frame: { id: "main" } });

    await expect(agentPageActivationBlock(contents as never)).resolves.toBe("nested");
  });

  it("refuses activation keys when an embedded frame owns focus", async () => {
    const { activationStates, contents, debuggerEvents, sendCommand } = boundaryContents();
    activationStates.push("nested");
    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", { frame: { id: "main" } });

    await expect(agentPageActivationBlock(contents as never)).resolves.toBe("nested");
    expect(sendCommand).not.toHaveBeenCalledWith("DOM.describeNode", expect.anything());
  });
});

describe("agent Browser input settlement", () => {
  it("keeps the action serialized when dispatch rejects after navigation starts", async () => {
    const contents = Object.assign(new EventEmitter(), {
      getURL: () => "http://127.0.0.1:3000/destination",
      isDestroyed: () => false,
      stop: vi.fn(),
    });
    let rejectDispatch = (_error: Error): void => undefined;
    const dispatch = new Promise<void>((_resolve, reject) => { rejectDispatch = reject; });

    const settlement = settleAgentPageInput(contents as never, () => dispatch);
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "http://127.0.0.1:3000/destination",
    });
    rejectDispatch(new Error("Execution context was destroyed."));
    let settled = false;
    void settlement.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    contents.emit("did-stop-loading");
    await expect(settlement).rejects.toThrow("Execution context was destroyed.");
    expect(contents.stop).not.toHaveBeenCalled();
  });
});

describe("agent Browser slow navigation settlement", () => {
  it("returns control after twenty seconds without stopping a navigation that is still loading", async () => {
    vi.useFakeTimers();
    try {
      const contents = Object.assign(new EventEmitter(), {
        getURL: () => "http://127.0.0.1:3000/source",
        isDestroyed: () => false,
        stop: vi.fn(),
      });
      const settlement = settleAgentPageInput(contents as never, () => undefined);
      await Promise.resolve();
      contents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
        url: "http://127.0.0.1:3000/slow-destination",
      });
      let settled = false;
      void settlement.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(settlement).resolves.toBeUndefined();
      expect(contents.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agent Browser file chooser boundary", () => {
  function chooserContents() {
    let attached = false;
    const sendCommand = vi.fn(async () => undefined);
    return {
      contents: Object.assign(new EventEmitter(), {
        debugger: {
          attach: vi.fn(() => { attached = true; }),
          detach: vi.fn(() => { attached = false; }),
          isAttached: vi.fn(() => attached),
          on: vi.fn(),
          removeListener: vi.fn(),
          sendCommand,
        },
        getURL: () => "http://127.0.0.1:3000/",
        executeJavaScriptInIsolatedWorld: vi.fn(async () => false),
        isDestroyed: () => false,
        navigationHistory: {
          getActiveIndex: () => 0,
          getEntryAtIndex: () => ({ url: "http://127.0.0.1:3000/" }),
        },
      }),
      sendCommand,
    };
  }

  it("restores native human choosers when the agent activation is gone", async () => {
    const { contents, sendCommand } = chooserContents();
    const generation = await beginAgentFileChooserBlock(contents as never);

    await releaseAgentFileChooserBlock(contents as never, generation);

    expect(sendCommand).toHaveBeenNthCalledWith(
      4,
      "Page.setInterceptFileChooserDialog",
      { enabled: true, cancel: true },
    );
    expect(sendCommand).toHaveBeenLastCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: false },
    );
  });

  it("does not let an older release disable a newer agent action", async () => {
    const { contents, sendCommand } = chooserContents();
    const first = await beginAgentFileChooserBlock(contents as never);
    const second = await beginAgentFileChooserBlock(contents as never);

    await releaseAgentFileChooserBlock(contents as never, first);

    expect(second).toBeGreaterThan(first);
    expect(sendCommand).not.toHaveBeenLastCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: false },
    );
  });

  it("reinstalls the security debugger after something else detached it", async () => {
    const { contents } = chooserContents();
    await ensureAgentFileChooserBlock(contents as never);
    await ensureAgentFileChooserBlock(contents as never);
    expect(contents.debugger.attach).toHaveBeenCalledOnce();

    contents.debugger.detach();
    contents.debugger.detach.mockClear();
    await ensureAgentFileChooserBlock(contents as never);
    expect(contents.debugger.attach).toHaveBeenCalledTimes(2);
    expect(contents.debugger.isAttached()).toBe(true);
  });

  it("does not let a release from before a debugger reset disable the new agent action", async () => {
    const { contents, sendCommand } = chooserContents();
    const stale = await beginAgentFileChooserBlock(contents as never);
    resetAgentFileChooserBlock(contents as never);
    expect(contents.debugger.detach).toHaveBeenCalledOnce();
    const current = await beginAgentFileChooserBlock(contents as never);

    await releaseAgentFileChooserBlock(contents as never, stale);

    expect(current).not.toBe(stale);
    expect(contents.debugger.attach).toHaveBeenCalledTimes(2);
    expect(sendCommand).toHaveBeenLastCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: true, cancel: true },
    );
  });
});
