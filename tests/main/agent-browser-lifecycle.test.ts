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
