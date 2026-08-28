import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { RuntimeProcessContainmentAdmission } from "../../src/main/runtime-process-containment-admission";
import type { RuntimeOwnedProcessContainment } from "../../src/node/runtime-owned-processes";
import { createRuntimeProcessRecord } from "../../src/main/runtime-supervisor-process-record";

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 4_242;
  postMessage(): void {}
  kill(): boolean { return true; }
}

describe("runtime process containment admission", () => {
  it("does not admit runtime work until asynchronous containment is armed", async () => {
    let resolveContainment!: (
      value: RuntimeOwnedProcessContainment | null,
    ) => void;
    const armed = new Promise<RuntimeOwnedProcessContainment | null>(
      (resolve) => { resolveContainment = resolve; },
    );
    const containment = {
      kind: "windows-job-v1",
      name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
    } as const;
    const child = new FakeUtilityProcess();
    const record = createRuntimeProcessRecord({
      child: child as never,
      generation: 1,
      runtimeGenerationId: "20000000-0000-4000-8000-000000000002:1",
      cleanupReceiptIds: [],
    });
    const post = vi.fn(() => true);
    const onStartPosted = vi.fn();
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
      onStartPosted,
      reject: vi.fn(),
    });

    admission.bind(record);
    child.emit("spawn");
    expect(post).not.toHaveBeenCalled();

    resolveContainment(containment);
    await Promise.resolve();

    expect(post).toHaveBeenCalledWith(record, expect.objectContaining({
      type: "runtime.start",
    }));
    expect(onStartPosted).toHaveBeenCalledOnce();
    expect(onStartPosted).toHaveBeenCalledWith(record);
  });

  it("ignores an expected containment rejection after runtime stop", async () => {
    let rejectContainment!: (error: Error) => void;
    const armed = new Promise<RuntimeOwnedProcessContainment | null>(
      (_resolve, reject) => { rejectContainment = reject; },
    );
    const child = new FakeUtilityProcess();
    const record = createRuntimeProcessRecord({
      child: child as never,
      generation: 1,
      runtimeGenerationId: "20000000-0000-4000-8000-000000000002:1",
      cleanupReceiptIds: [],
    });
    let runningDesired = true;
    const persist = vi.fn(() => true);
    const post = vi.fn(() => true);
    const onStartPosted = vi.fn();
    const reject = vi.fn();
    const admission = new RuntimeProcessContainmentAdmission({
      arm: vi.fn(() => armed),
      systemBootId: "test:10000000-0000-4000-8000-000000000001",
      workerOptions: {
        dataDirectory: "/runtime",
        defaultWorkspacePath: "/workspace",
        enableProviders: false,
      },
      isCurrent: (candidate) => candidate === record,
      isRunningDesired: () => runningDesired,
      hasQuarantinedProcesses: () => false,
      persist,
      post,
      onStartPosted,
      reject,
    });

    admission.bind(record);
    child.emit("spawn");
    runningDesired = false;
    rejectContainment(new Error(
      "The Windows runtime process admission is no longer current.",
    ));
    await Promise.resolve();
    await Promise.resolve();

    expect(reject).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(onStartPosted).not.toHaveBeenCalled();
  });

  it("rejects an active containment failure without starting readiness", async () => {
    let rejectContainment!: (error: Error) => void;
    const armed = new Promise<RuntimeOwnedProcessContainment | null>(
      (_resolve, reject) => { rejectContainment = reject; },
    );
    const child = new FakeUtilityProcess();
    const record = createRuntimeProcessRecord({
      child: child as never,
      generation: 1,
      runtimeGenerationId: "20000000-0000-4000-8000-000000000002:1",
      cleanupReceiptIds: [],
    });
    const post = vi.fn(() => true);
    const onStartPosted = vi.fn();
    const reject = vi.fn();
    const admission = new RuntimeProcessContainmentAdmission({
      arm: () => armed,
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
      onStartPosted,
      reject,
    });

    admission.bind(record);
    child.emit("spawn");
    const failure = new Error("The Windows runtime Job Object could not be armed.");
    rejectContainment(failure);
    await Promise.resolve();
    await Promise.resolve();

    expect(reject).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledWith(record, failure);
    expect(post).not.toHaveBeenCalled();
    expect(onStartPosted).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a late containment %s after the runtime process exits",
    async (settlement) => {
      let resolveContainment!: (
        value: RuntimeOwnedProcessContainment | null,
      ) => void;
      let rejectContainment!: (error: Error) => void;
      const armed = new Promise<RuntimeOwnedProcessContainment | null>(
        (resolve, reject) => {
          resolveContainment = resolve;
          rejectContainment = reject;
        },
      );
      const containment = {
        kind: "windows-job-v1",
        name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
      } as const;
      const child = new FakeUtilityProcess();
      const record = createRuntimeProcessRecord({
        child: child as never,
        generation: 1,
        runtimeGenerationId: "20000000-0000-4000-8000-000000000002:1",
        cleanupReceiptIds: [],
      });
      const persist = vi.fn(() => true);
      const post = vi.fn(() => true);
      const onStartPosted = vi.fn();
      const reject = vi.fn();
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
        persist,
        post,
        onStartPosted,
        reject,
      });

      admission.bind(record);
      child.emit("spawn");
      child.pid = undefined;
      if (settlement === "resolve") resolveContainment(containment);
      else rejectContainment(new Error("The runtime process exited."));
      await Promise.resolve();
      await Promise.resolve();

      expect(reject).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(onStartPosted).not.toHaveBeenCalled();
    },
  );

  it("starts readiness only after persistence and runtime.start posting succeed", () => {
    const containment = {
      kind: "windows-job-v1",
      name: `Global\\InertiaRuntime-${"a".repeat(64)}`,
    } as const;
    const child = new FakeUtilityProcess();
    const record = createRuntimeProcessRecord({
      child: child as never,
      generation: 1,
      runtimeGenerationId: "20000000-0000-4000-8000-000000000002:1",
      cleanupReceiptIds: [],
    });
    const calls: string[] = [];
    const reject = vi.fn();
    const admission = new RuntimeProcessContainmentAdmission({
      arm: () => containment,
      systemBootId: "test:10000000-0000-4000-8000-000000000001",
      workerOptions: {
        dataDirectory: "/runtime",
        defaultWorkspacePath: "/workspace",
        enableProviders: false,
      },
      isCurrent: (candidate) => candidate === record,
      isRunningDesired: () => true,
      hasQuarantinedProcesses: () => false,
      persist: () => { calls.push("persist"); return true; },
      post: () => { calls.push("post"); return true; },
      onStartPosted: () => { calls.push("readiness"); },
      reject,
    });

    admission.bind(record);
    child.emit("spawn");

    expect(calls).toEqual(["persist", "post", "readiness"]);
    expect(reject).not.toHaveBeenCalled();
  });

  it("does not start readiness when runtime.start cannot be posted", () => {
    const child = new FakeUtilityProcess();
    const record = createRuntimeProcessRecord({
      child: child as never,
      generation: 1,
      runtimeGenerationId: "20000000-0000-4000-8000-000000000002:1",
      cleanupReceiptIds: [],
    });
    const onStartPosted = vi.fn();
    const admission = new RuntimeProcessContainmentAdmission({
      arm: () => null,
      systemBootId: "test:10000000-0000-4000-8000-000000000001",
      workerOptions: {
        dataDirectory: "/runtime",
        defaultWorkspacePath: "/workspace",
        enableProviders: false,
      },
      isCurrent: (candidate) => candidate === record,
      isRunningDesired: () => true,
      hasQuarantinedProcesses: () => false,
      persist: () => true,
      post: () => false,
      onStartPosted,
      reject: vi.fn(),
    });

    admission.bind(record);
    child.emit("spawn");

    expect(onStartPosted).not.toHaveBeenCalled();
  });
});
