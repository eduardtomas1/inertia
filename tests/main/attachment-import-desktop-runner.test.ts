import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import { expect, it, vi } from "vitest";

import { probeCanvasInEnvironment } from "../helpers/canvas-in-environment";

const native = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: native }));
import { attachmentImportRunner } from "../../src/main/attachment-import-desktop-runner";

class Worker extends EventEmitter {
  kill = vi.fn(() => true);
  postMessage = vi.fn();
}

it("validates imported images without loading system fonts on every import", async () => {
  const worker = new Worker();
  native.fork.mockReset().mockReturnValue(worker);
  const controller = new AbortController();
  const importing = attachmentImportRunner({
    root: resolve("/tmp", "inertia-attachment-import"),
    rootDev: "1",
    rootIno: "2",
    rootUid: null,
    fileName: "11111111-1111-4111-8111-111111111111.png",
    name: "screenshot.png",
    mimeType: "image/png",
    size: 100,
    stallBeforeValidationMs: 0,
  }, controller.signal);
  controller.abort();
  worker.emit("exit", 1);
  await expect(importing.result).rejects.toThrow();
  const env = native.fork.mock.calls[0]![2].env as Record<string, string>;
  expect(env).toEqual({ DISABLE_SYSTEM_FONTS_LOAD: "1" });
  expect(probeCanvasInEnvironment(env)).toEqual({
    families: 0,
    decoded: [1920, 1080],
    reencoded: [1920, 1080],
  });
});
