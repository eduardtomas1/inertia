import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { transformWithEsbuild } from "vite";
import type { SnapshotDelivery } from "../../src/shared/snapshots";
import type { useComposerSnapshots } from "../../src/renderer/src/components/composer/useComposerSnapshots";

const original = window.inertia;
const disposers: Array<() => void> = [];
let compiledHook: string;
beforeAll(async () => {
  const filename = resolve("src/renderer/src/components/composer/useComposerSnapshots.ts");
  // Re-evaluate the actual hook with Vite's preserved hot.data and the same React
  // instance. Only the development import.meta.hot object is supplied by the test.
  compiledHook = (await transformWithEsbuild(readFileSync(filename, "utf8"), filename, {
    loader: "ts", format: "cjs", define: { "import.meta.hot": "snapshotHot" },
  })).code;
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  window.inertia = original;
});
function loadHook(data: Record<string, unknown>, development = true): typeof useComposerSnapshots {
  const module: { exports: { useComposerSnapshots?: typeof useComposerSnapshots } } = { exports: {} };
  runInNewContext(compiledHook, {
    module, exports: module.exports, window, document, CustomEvent,
    snapshotHot: development ? { data, dispose: (cleanup: () => void) => disposers.push(cleanup) } : undefined,
    require: (name: string) => {
      if (name !== "react") throw new Error("Unexpected hook runtime import");
      return React;
    },
  });
  if (!module.exports.useComposerSnapshots) throw new Error("Snapshot hook export missing");
  return module.exports.useComposerSnapshots;
}
function fixture() {
  const listeners = new Set<(event: SnapshotDelivery) => void>();
  const unsubscribe = vi.fn();
  const cancel = vi.fn(async () => undefined);
  const snapshot = vi.fn(async () => ({ enabled: true, shortcut: "accelerator" as const, available: true, permission: "granted" as const, message: null }));
  window.inertia = { ...original, snapshot, cancelAttachmentImport: cancel, onSnapshot: (listener) => {
    listeners.add(listener);
    return () => { unsubscribe(); listeners.delete(listener); };
  } };
  const deliver = (batchId: string) => act(() => {
    for (const listener of listeners) listener({ conversationId: "chat-a", selection: { batchId, attachments: [] } });
  });
  return { listeners, unsubscribe, cancel, snapshot, deliver };
}

it.each([false, true])("replaces the old development sink when dependency disposal runs first: %s", async (disposeFirst) => {
  const { listeners, unsubscribe, cancel, deliver } = fixture();
  const data = {};
  const useFirst = loadHook(data);
  const first = renderHook(() => useFirst("chat-a", async () => "adopted", React.useRef(null)));
  first.unmount();
  expect(listeners.size).toBe(1);
  expect(unsubscribe).not.toHaveBeenCalled();
  // Dependency updates accepted by Composer may re-evaluate this hook without
  // calling its dispose callback; both Vite lifecycle paths must retire the sink.
  const firstDispose = disposers[0];
  if (disposeFirst) firstDispose?.();
  const useSecond = loadHook(data);
  const adopt = vi.fn(async () => "adopted" as const);
  const second = renderHook(() => useSecond("chat-a", adopt, React.useRef(null)));
  deliver("hot-delivery");
  await waitFor(() => expect(adopt).toHaveBeenCalledOnce());
  expect(cancel).not.toHaveBeenCalled();
  expect(listeners.size).toBe(1);
  expect(unsubscribe).toHaveBeenCalledOnce();
  firstDispose?.(); // Repeated old disposal cannot remove the new sink.
  expect(listeners.size).toBe(1);
  second.unmount();
  deliver("queued-after-unbind");
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("queued-after-unbind"));
});

it("retains the production orphan sink across ordinary remounts", async () => {
  const { listeners, unsubscribe, cancel, snapshot, deliver } = fixture();
  const useSnapshot = loadHook({}, false);
  const mount = () => renderHook(() => useSnapshot("chat-a", async () => "adopted", React.useRef(null)));
  mount().unmount(); mount().unmount();
  expect(snapshot).toHaveBeenLastCalledWith({ type: "unbind" });
  expect(listeners.size).toBe(1);
  expect(unsubscribe).not.toHaveBeenCalled();
  deliver("production-orphan");
  await waitFor(() => expect(cancel).toHaveBeenCalledWith("production-orphan"));
});
