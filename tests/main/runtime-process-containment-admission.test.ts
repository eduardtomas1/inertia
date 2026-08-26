import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { RuntimeProcessContainmentAdmission } from "../../src/main/runtime-process-containment-admission";
import { createRuntimeProcessRecord } from "../../src/main/runtime-supervisor-process-record";

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 4_242;
  postMessage(): void {}
  kill(): boolean { return true; }
}

describe("runtime process containment admission", () => {
  it("does not admit runtime work until asynchronous containment is armed", async () => {
    let resolveContainment!: (value: null) => void;
    const armed = new Promise<null>((resolve) => { resolveContainment = resolve; });
    const child = new FakeUtilityProcess();
    const record = createRuntimeProcessRecord({
      child: child as never,
      generation: 1,
      runtimeGenerationId: "20000000-0000-4000-8000-000000000002:1",
      cleanupReceiptIds: [],
    });
    const post = vi.fn();
    const admission = new RuntimeProcessContainmentAdmission({
      arm: vi.fn(() => armed),
      systemBootId: "test:10000000-0000-4000-8000-000000000001",
      workerOptions: {
        dataDirectory: "/runtime",
        defaultWorkspacePath: "/workspace",
        enableProviders: false,
      },
      isCurrent: (candidate) => candidate === record,
      isRunningDesired: () => true,
      hasQuarantinedProcesses: () => false,
      persist: vi.fn(() => true),
      post,
      reject: vi.fn(),
    });

    admission.bind(record);
    child.emit("spawn");
    expect(post).not.toHaveBeenCalled();

    resolveContainment(null);
    await Promise.resolve();

    expect(post).toHaveBeenCalledWith(record, expect.objectContaining({
      type: "runtime.start",
    }));
  });
});
