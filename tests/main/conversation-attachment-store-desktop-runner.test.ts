import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import { expect, it, vi } from "vitest";

import { probeCanvasInEnvironment } from "../helpers/canvas-in-environment";

const native = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: native }));
import { conversationAttachmentStoreRunner } from "../../src/main/conversation-attachment-store-desktop-runner";

class Worker extends EventEmitter {
  kill = vi.fn(() => true);
  postMessage = vi.fn();
}

it("validates retained images without loading system fonts on every read", async () => {
  const worker = new Worker();
  native.fork.mockReset().mockReturnValue(worker);
  const controller = new AbortController();
  const reading = conversationAttachmentStoreRunner({
    operation: "read",
    root: resolve("/tmp", "conversation-attachments"),
    rootDev: "1",
    rootIno: "2",
    rootUid: null,
    id: "11111111-1111-4111-8111-111111111111",
    stallBeforeRecordRevalidateMs: 0,
    validateContent: true,
  }, controller.signal);
  controller.abort();
  worker.emit("exit", 1);
  await expect(reading.result).rejects.toThrow();
  const env = native.fork.mock.calls[0]![2].env as Record<string, string>;
  expect(env).toEqual({ DISABLE_SYSTEM_FONTS_LOAD: "1" });
  expect(probeCanvasInEnvironment(env)).toEqual({
    families: 0,
    decoded: [1920, 1080],
    reencoded: [1920, 1080],
  });
});
