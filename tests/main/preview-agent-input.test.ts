import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  agentPageActivationBlock,
  agentPageHasUnguardedNestedContent,
  beginAgentFileChooserBlock,
  hasUnguardedAgentPageContent,
  installAgentFileChooserBlock,
  releaseAgentFileChooserBlock,
  settleAgentPageInput,
} from "../../src/main/preview-agent-input";

describe("agent Browser nested evidence boundary", () => {
  function boundaryCommands(closedRoot = false) {
    return vi.fn(async (method: string) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        return { result: { type: "object", subtype: "array", objectId: "boundary-hosts" } };
      }
      if (method === "Runtime.getProperties") {
        return {
          result: [
            ...(closedRoot ? [{
              name: "0",
              value: { type: "object", subtype: "node", objectId: "closed-host" },
            }] : []),
            { name: "length", value: { type: "number", value: closedRoot ? 1 : 0 } },
          ],
        };
      }
      if (method === "DOM.describeNode") {
        return {
          node: {
            nodeType: 1,
            attributes: [],
            shadowRoots: [{ nodeType: 11, shadowRootType: "closed" }],
          },
        };
      }
      return undefined;
    });
  }

  it("allows only an initialized boundary state with no nested content", () => {
    expect(hasUnguardedAgentPageContent({
      mainFrameId: "main",
      nestedContentObserved: false,
    })).toBe(false);
  });

  it("rechecks focused activation after the privileged nested-content scan", async () => {
    const debuggerEvents = new EventEmitter();
    let attached = false;
    const activationStates = [null, "disabled"];
    const contents = {
      debugger: Object.assign(debuggerEvents, {
        attach: vi.fn(() => { attached = true; }),
        detach: vi.fn(() => { attached = false; }),
        isAttached: vi.fn(() => attached),
        sendCommand: boundaryCommands(),
      }),
      executeJavaScriptInIsolatedWorld: vi.fn(async () => activationStates.shift() ?? null),
      getURL: () => "http://127.0.0.1:3000/focus-race",
      loadURL: vi.fn(async () => undefined),
      navigationHistory: {
        getActiveIndex: () => 0,
        getEntryAtIndex: () => ({ url: "http://127.0.0.1:3000/focus-race" }),
      },
    };
    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", { frame: { id: "main" } });

    await expect(agentPageActivationBlock(contents as never)).resolves.toBe("disabled");
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });

  it("fails closed for tainted or malformed boundary state", () => {
    expect(hasUnguardedAgentPageContent({ nestedContentObserved: true })).toBe(true);
    expect(hasUnguardedAgentPageContent({})).toBe(true);
    expect(hasUnguardedAgentPageContent(undefined)).toBe(true);
  });

  it("tracks nested boundaries incrementally without serializing the page DOM", async () => {
    const debuggerEvents = new EventEmitter();
    let attached = false;
    const sendCommand = boundaryCommands();
    const contents = {
      debugger: Object.assign(debuggerEvents, {
        attach: vi.fn(() => { attached = true; }),
        detach: vi.fn(() => { attached = false; }),
        isAttached: vi.fn(() => attached),
        sendCommand,
      }),
      getURL: () => "http://127.0.0.1:3000/",
      loadURL: vi.fn(async () => undefined),
      navigationHistory: {
        getActiveIndex: () => 0,
        getEntryAtIndex: () => ({ url: "http://127.0.0.1:3000/" }),
      },
    };

    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "main" },
    });
    expect(await agentPageHasUnguardedNestedContent(contents as never)).toBe(false);
    expect(sendCommand).not.toHaveBeenCalledWith("Page.getFrameTree");
    expect(sendCommand).not.toHaveBeenCalledWith("DOMSnapshot.captureSnapshot", expect.anything());
    expect(sendCommand).not.toHaveBeenCalledWith("DOM.performSearch", expect.anything());

    debuggerEvents.emit("message", {}, "Page.frameAttached", {
      frameId: "child",
      parentFrameId: "main",
    });
    expect(await agentPageHasUnguardedNestedContent(contents as never)).toBe(true);

    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "next-main" },
    });
    expect(await agentPageHasUnguardedNestedContent(contents as never)).toBe(false);

    debuggerEvents.emit("message", {}, "DOM.shadowRootPushed", {
      root: { shadowRootType: "closed" },
    });
    expect(await agentPageHasUnguardedNestedContent(contents as never)).toBe(true);
  });

  it("detects a parser-created closed root through bounded depth-zero host descriptors", async () => {
    const debuggerEvents = new EventEmitter();
    let attached = false;
    const sendCommand = boundaryCommands(true);
    const contents = {
      debugger: Object.assign(debuggerEvents, {
        attach: vi.fn(() => { attached = true; }),
        detach: vi.fn(() => { attached = false; }),
        isAttached: vi.fn(() => attached),
        sendCommand,
      }),
      getURL: () => "http://127.0.0.1:3000/closed-root",
      loadURL: vi.fn(async () => undefined),
      navigationHistory: {
        getActiveIndex: () => 0,
        getEntryAtIndex: () => ({ url: "http://127.0.0.1:3000/closed-root" }),
      },
    };

    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "main" },
    });
    await expect(agentPageHasUnguardedNestedContent(contents as never)).resolves.toBe(true);
    expect(sendCommand).not.toHaveBeenCalledWith("DOM.performSearch", expect.anything());
    expect(sendCommand).toHaveBeenCalledWith("DOM.describeNode", {
      objectId: "closed-host",
      depth: 0,
      pierce: true,
    });
  });

  it("fails one unstable bounded prepass closed without lifetime-tainting the document", async () => {
    const debuggerEvents = new EventEmitter();
    let attached = false;
    let unstable = true;
    let evaluationParams: unknown;
    const sendCommand = vi.fn(async (method: string, params?: unknown) => {
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "Runtime.evaluate") {
        evaluationParams = params;
        return unstable
          ? { result: { type: "object", subtype: "null", value: null } }
          : { result: { type: "object", subtype: "array", objectId: "boundary-hosts" } };
      }
      if (method === "Runtime.getProperties") {
        return { result: [{ name: "length", value: { type: "number", value: 0 } }] };
      }
      return undefined;
    });
    const contents = {
      debugger: Object.assign(debuggerEvents, {
        attach: vi.fn(() => { attached = true; }),
        detach: vi.fn(() => { attached = false; }),
        isAttached: vi.fn(() => attached),
        sendCommand,
      }),
      getURL: () => "http://127.0.0.1:3000/dashboard",
      loadURL: vi.fn(async () => undefined),
      navigationHistory: {
        getActiveIndex: () => 0,
        getEntryAtIndex: () => ({ url: "http://127.0.0.1:3000/dashboard" }),
      },
    };

    await installAgentFileChooserBlock(contents as never);
    debuggerEvents.emit("message", {}, "Page.frameNavigated", {
      frame: { id: "main" },
    });
    await expect(agentPageHasUnguardedNestedContent(contents as never)).resolves.toBe(true);
    expect(sendCommand).not.toHaveBeenCalledWith("DOM.describeNode", expect.anything());
    unstable = false;
    await expect(agentPageHasUnguardedNestedContent(contents as never)).resolves.toBe(false);
    expect(evaluationParams).toMatchObject({
      expression: expect.stringContaining("attributeCharacters > 16384"),
      timeout: 3_000,
    });
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

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(sendCommand).not.toHaveBeenLastCalledWith(
      "Page.setInterceptFileChooserDialog",
      { enabled: false },
    );
  });
});
