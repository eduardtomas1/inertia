import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

const { electronState, pageTools } = await vi.hoisted(async () => {
  const support = await import("./support/preview-broker-harness");
  return {
    electronState: support.createPreviewBrokerElectronState(),
    pageTools: support.createPreviewBrokerPageTools(),
  };
});

vi.mock("electron", async () => (
  (await import("./support/preview-broker-harness")).createPreviewBrokerElectronMock(electronState)
));
vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewBroker } from "../../src/main/preview-broker";
import {
  connectionId,
  conversationId,
  createPreviewBrokerHarness,
  runIdentity,
} from "./support/preview-broker-harness";

const harness = () => createPreviewBrokerHarness(PreviewBroker);

function listenerCount(contents: object): number {
  const handlers = Reflect.get(contents, "handlers") as Map<string, unknown[]>;
  const debuggerHandlers = Reflect.get(contents, "debuggerMessageHandlers") as unknown[];
  return [...handlers.values()].reduce((total, list) => total + list.length, 0) + debuggerHandlers.length;
}

describe("Browser lifecycle", () => {
  it("removes a once listener by its original handler like Node's EventEmitter", async () => {
    const { WebContentsView } = await import("electron");
    const contents = new WebContentsView({}).webContents as unknown as {
      once(name: string, handler: () => void): void;
      removeListener(name: string, handler: () => void): void;
      emit(name: string): void;
    };
    const handler = vi.fn();
    contents.once("destroyed", handler);
    contents.once("destroyed", handler);
    contents.removeListener("destroyed", handler);
    contents.emit("destroyed");
    contents.emit("destroyed");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not grow page listeners across 50 show/hide cycles with commands", async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness();
      const owner = { ownerId: "primary", contextId: conversationId, connectionId };
      const settled = async <T>(operation: Promise<T>): Promise<T> => {
        await vi.advanceTimersByTimeAsync(2_000);
        return await operation;
      };
      broker.connect(owner);
      broker.setBounds({ ...owner, bounds: { x: 0, y: 0, width: 900, height: 600 } });
      await settled(broker.navigate({ ...owner, url: "http://127.0.0.1:3000/cycle" }));
      const contents = electronState.contents.at(-1)!;
      await settled(broker.perform(runIdentity, { action: "snapshot" }));
      const baseline = listenerCount(contents);
      for (let index = 0; index < 50; index += 1) {
        broker.setBounds({ ...owner, bounds: { x: 0, y: 0, width: 900 + (index % 2), height: 600 } });
        expect(await settled(broker.perform(runIdentity, { action: "snapshot" }))).toMatchObject({ ok: true });
        broker.setBounds({ ...owner, bounds: null });
        expect(await settled(broker.perform(runIdentity, { action: "click", ref: "e1" }))).toMatchObject({ ok: true });
        broker.closeRequest(owner);
        broker.connect(owner);
      }
      expect(listenerCount(contents)).toBe(baseline);
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps at most four hidden Browsers after six concurrent agents start at once", async () => {
    vi.useFakeTimers();
    try {
      const window = harness().window;
      const broker = new PreviewBroker({
        getWindow: () => window as never,
        openExternal: vi.fn(async () => undefined),
        stateChannel: "preview-state",
      });
      const offset = electronState.contents.length;
      const results = await Promise.all([1, 2, 3, 4, 5, 6].map((index) => broker.perform({
        ...runIdentity,
        conversationId: `9999999${index}-9999-4999-8999-999999999999`,
      }, { action: "tabs" })));
      expect(results.every((result) => result.ok)).toBe(true);
      const alive = electronState.contents.slice(offset).filter((contents) => !contents.isDestroyed());
      expect(alive).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(electronState.contents.slice(offset).every((contents) => contents.isDestroyed())).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["isCrashed throws synchronously", (contents: Record<string, unknown>) => {
      contents.isCrashed = () => { throw new Error("sync crash probe"); };
    }],
    ["a page tool throws synchronously", () => {
      pageTools.installAgentPagePrivacyGuard.mockImplementationOnce(() => { throw new Error("sync guard"); });
    }],
  ])("restores background throttling when %s", async (_label, arm) => {
    vi.useFakeTimers();
    try {
      const { broker } = harness();
      const offset = electronState.contents.length;
      await broker.perform(runIdentity, { action: "navigate", url: "http://127.0.0.1:3000/throw" });
      const contents = electronState.contents[offset]! as unknown as Record<string, unknown> & { throttling: boolean[] };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(contents.throttling.at(-1)).toBe(true);
      arm(contents);
      const result = await broker.perform(runIdentity, { action: "snapshot" });
      expect(result.ok).toBe(false);
      expect(contents.throttling.at(-1)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(contents.throttling.at(-1)).toBe(true);
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a document with more than 4,000 inputs", () => {
  it("is withheld as too large to inspect, not as a password change", async () => {
    const actual = await vi.importActual<typeof import("../../src/main/preview-agent-page")>(
      "../../src/main/preview-agent-page",
    );
    const inputs = Array.from({ length: 4_001 }, () => ({ tagName: "INPUT", type: "checkbox", value: "on" }));
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        passwordNodes: new WeakSet(),
        passwordValues: new Set<string>(),
      },
      document: { documentElement: {}, getElementsByTagName: () => inputs },
    };
    const { broker } = harness();
    await broker.navigate({ ownerId: "primary", contextId: conversationId, url: "http://127.0.0.1:3000/grid" });
    const contents = electronState.contents.at(-1)!;
    const sendCommand = contents.debugger.sendCommand.getMockImplementation()!;
    let evaluated = 0;
    contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method !== "Runtime.evaluate" || typeof params?.expression !== "string"
        || !params.expression.includes("privacyGuardInstalled")) return await sendCommand(method, params);
      evaluated += 1;
      return { result: { type: "string", value: runInNewContext(params.expression, context) } };
    });
    pageTools.agentPageEvidencePrivacy.mockImplementationOnce(
      async (...args: unknown[]) => await actual.agentPageEvidencePrivacy(args[0] as never),
    );
    const result = await broker.perform(conversationId, { action: "snapshot" });
    expect(evaluated).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false, code: "sensitive" });
    const message = result.ok ? "" : result.message;
    expect(message).toContain("more than 4,000 inputs");
    expect(message).toContain("smaller page");
    expect(message).not.toContain("a script changed a password field");
    expect(message).not.toContain("Navigate to the page again");
    broker.close();
  });
});
