import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  hasUnguardedAgentPageContent,
  settleAgentPageInput,
} from "../../src/main/preview-agent-input";

const rootFrame = { frameTree: { frame: { id: "main" } } };

describe("agent Browser nested evidence boundary", () => {
  it("allows a valid top-level document with only Chromium-owned shadow roots", () => {
    expect(hasUnguardedAgentPageContent(rootFrame, {
      strings: ["user-agent"],
      documents: [{ nodes: { shadowRootType: { index: [2], value: [0] } } }],
    })).toBe(false);
  });

  it("fails closed for child frames and author-controlled shadow roots", () => {
    expect(hasUnguardedAgentPageContent({
      frameTree: {
        frame: { id: "main" },
        childFrames: [{ frame: { id: "child" } }],
      },
    }, {
      strings: [],
      documents: [{ nodes: {} }],
    })).toBe(true);
    for (const type of ["open", "closed"]) {
      expect(hasUnguardedAgentPageContent(rootFrame, {
        strings: [type],
        documents: [{ nodes: { shadowRootType: { index: [4], value: [0] } } }],
      })).toBe(true);
    }
  });

  it("fails closed when either debugger structure is malformed", () => {
    expect(hasUnguardedAgentPageContent({}, {})).toBe(true);
    expect(hasUnguardedAgentPageContent(rootFrame, {
      strings: ["open"],
      documents: [{ nodes: { shadowRootType: { index: [1], value: [] } } }],
    })).toBe(true);
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
