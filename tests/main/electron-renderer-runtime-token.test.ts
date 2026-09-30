import { EventEmitter } from "node:events";

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { observeElectronPage } from "../e2e/support/electron-app-lifecycle";

const token = "4f1c2b8e9d7a6f5e4d3c2b1a0f9e8d7c";

function consoleError(text: string) {
  return {
    type: () => "error",
    text: () => text,
    location: () => ({ url: "inertia://bundle/assets/runtime.js", line: 1, column: 0, lineNumber: 1, columnNumber: 0 }),
  };
}

function runtimeSocket(url: string): EventEmitter & { url: () => string } {
  return Object.assign(new EventEmitter(), { url: () => url });
}

describe("renderer error ledger runtime capability redaction", () => {
  it("keeps the runtime WebSocket capability token out of the renderer error ledger", () => {
    const events = new EventEmitter();
    const rendererErrors: string[] = [];
    observeElectronPage(events as unknown as Page, rendererErrors);
    events.emit("console", consoleError(
      `WebSocket connection to 'ws://127.0.0.1:56724/runtime/${token}' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED`,
    ));
    expect(rendererErrors).toHaveLength(1);
    expect(rendererErrors.join("\n")).not.toContain(token);
  });

  it("redacts the capability in page errors and failed runtime requests", () => {
    const events = new EventEmitter();
    const rendererErrors: string[] = [];
    observeElectronPage(events as unknown as Page, rendererErrors);
    events.emit("pageerror", new Error(`Runtime socket ws://127.0.0.1:56724/runtime/${token}?afterSequence=4 closed`));
    events.emit("requestfailed", {
      method: () => "GET",
      resourceType: () => "websocket",
      url: () => `http://127.0.0.1:56724/runtime/${token}`,
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
    });
    expect(rendererErrors).toEqual([
      "Runtime socket ws://127.0.0.1:56724/runtime/redacted?afterSequence=4 closed",
      "Request failed GET websocket http://127.0.0.1:56724/runtime/redacted: net::ERR_CONNECTION_REFUSED",
    ]);
  });

  it("still clears a recovered buffer-space failure after redaction", () => {
    const events = new EventEmitter();
    const rendererErrors: string[] = [];
    observeElectronPage(events as unknown as Page, rendererErrors);
    const established = runtimeSocket(`ws://127.0.0.1:56724/runtime/${token}`);
    events.emit("websocket", established);
    events.emit("console", consoleError(
      `WebSocket connection to 'ws://127.0.0.1:56724/runtime/${token}' failed: Error in connection establishment: net::ERR_NO_BUFFER_SPACE`,
    ));
    expect(rendererErrors).toEqual([
      "WebSocket connection to 'ws://127.0.0.1:56724/runtime/redacted' failed: Error in connection establishment: net::ERR_NO_BUFFER_SPACE (inertia://bundle/assets/runtime.js:2:1)",
    ]);
    const reconnected = runtimeSocket(`ws://127.0.0.1:56724/runtime/${token}?runtimeGeneration=1`);
    events.emit("websocket", reconnected);
    reconnected.emit("framereceived", { payload: "welcome" });
    expect(rendererErrors).toEqual([]);
  });
});
