import { EventEmitter } from "node:events";
import { resolve } from "node:path";

import type { UtilityProcess } from "electron";
import { describe, expect, it, vi } from "vitest";

import { SecureFileBroker } from "../../src/main/secure-file-broker";
import type {
  SecureFileRequest,
  SecureFileResult,
} from "../../src/node/secure-file-protocol";

const request: SecureFileRequest = {
  operation: "read",
  root: resolve("/tmp", "workspace"),
  rootIdentity: { dev: "1", ino: "2" },
  parentIdentities: [{ dev: "1", ino: "3" }],
  targetIdentity: { dev: "1", ino: "4" },
  path: "src/example.ts",
  maxBytes: 1024,
};

const success: SecureFileResult = {
  ok: true,
  operation: "read",
  contentBase64: Buffer.from("ok").toString("base64"),
  metadata: {
    digest: "a".repeat(64),
    size: 2,
    modifiedAt: new Date(0).toISOString(),
    mode: 0o644,
  },
};

const replacement: SecureFileRequest = {
  ...request,
  operation: "replace",
  expectedDigest: "a".repeat(64),
  contentBase64: Buffer.from("replacement").toString("base64"),
  expectedMode: 0o644,
  mode: 0o644,
};

const conflict: SecureFileResult = {
  ok: false,
  code: "conflict",
  message: "The selected file changed during the secure save.",
};

const replacementSuccess: SecureFileResult = {
  ok: true,
  operation: "replace",
  metadata: success.metadata,
};

const recoveryRequest: SecureFileRequest = {
  operation: "recover",
  root: replacement.root,
  rootIdentity: replacement.rootIdentity,
  parentIdentities: replacement.parentIdentities,
  path: replacement.path,
};

function resultEvent(result: SecureFileResult): unknown {
  return { type: "secure-file.result", result };
}

class FakeUtilityProcess extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly postMessage = vi.fn();
}

function utility(fake: FakeUtilityProcess): UtilityProcess {
  return fake as unknown as UtilityProcess;
}

describe("secure file broker", () => {
  it("delivers one strict request and accepts one validated result", async () => {
    const child = new FakeUtilityProcess();
    let spawnedParent = "";
    const broker = new SecureFileBroker({
      spawn: (parent) => {
        spawnedParent = parent;
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    child.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("message", resultEvent(success));
        child.emit("exit", 0);
      });
    });

    await expect(broker.perform(request)).resolves.toEqual(success);
    expect(spawnedParent).toBe(resolve(request.root, "src"));
    expect(child.postMessage).toHaveBeenCalledWith({
      type: "secure-file.perform",
      request,
    });
    broker.close();
  });

  it("spawns root-level file helpers in the project root", async () => {
    const child = new FakeUtilityProcess();
    let spawnedParent = "";
    const broker = new SecureFileBroker({
      spawn: (parent) => {
        spawnedParent = parent;
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    child.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("message", resultEvent(success));
        child.emit("exit", 0);
      });
    });

    await expect(broker.perform({
      ...request,
      path: "example.ts",
      parentIdentities: [],
    })).resolves.toEqual(success);
    expect(spawnedParent).toBe(request.root);
    broker.close();
  });

  it("serializes operations for the same target", async () => {
    const children: FakeUtilityProcess[] = [];
    const broker = new SecureFileBroker({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });

    const first = broker.perform(request);
    const second = broker.perform(request);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit("message", resultEvent(success));
    children[0]!.emit("exit", 0);
    await expect(first).resolves.toEqual(success);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.emit("message", resultEvent(success));
    children[1]!.emit("exit", 0);
    await expect(second).resolves.toEqual(success);
    broker.close();
  });

  it("kills a timed-out helper and reports an unavailable outcome", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess();
      const broker = new SecureFileBroker({
        spawn: () => {
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 25,
        killGraceMs: 10,
      });
      const pending = broker.perform(request);
      await vi.advanceTimersByTimeAsync(25);
      expect(child.kill).toHaveBeenCalledOnce();
      child.emit("exit", 1);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers cancellation through commit and recovers after a forced exit", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 100,
        killGraceMs: 10,
      });
      const controller = new AbortController();
      const pending = broker.perform(replacement, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(1);
      children[0]!.emit("message", {
        type: "secure-file.commit",
        phase: "started",
      });

      controller.abort();
      expect(children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(children[0]!.kill).toHaveBeenCalledOnce();
      children[0]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);

      expect(children).toHaveLength(2);
      expect(children[1]!.postMessage).toHaveBeenCalledWith({
        type: "secure-file.recover",
        request: replacement,
      });
      children[1]!.emit("message", {
        type: "secure-file.recovery-result",
        ok: true,
      });
      children[1]!.emit("exit", 0);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
        message: "The secure file operation was cancelled.",
      });
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains an active commit and its recovery before shutdown completes", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 100,
        killGraceMs: 10,
      });
      const pending = broker.perform(replacement);
      await vi.advanceTimersByTimeAsync(0);
      children[0]!.emit("message", {
        type: "secure-file.commit",
        phase: "started",
      });

      let shutdownSettled = false;
      const shutdown = broker.shutdown().then((confirmed) => {
        shutdownSettled = true;
        return confirmed;
      });
      expect(children[0]!.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(children[0]!.kill).toHaveBeenCalledOnce();
      expect(shutdownSettled).toBe(false);

      children[0]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(2);
      children[1]!.emit("message", {
        type: "secure-file.recovery-result",
        ok: true,
      });
      children[1]!.emit("exit", 0);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      await expect(shutdown).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds shutdown when a killed helper never confirms exit", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess();
      const broker = new SecureFileBroker({
        spawn: () => {
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 20,
        killGraceMs: 5,
      });
      const pending = broker.perform(request);
      await vi.advanceTimersByTimeAsync(0);
      const shutdown = broker.shutdown();

      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      await vi.advanceTimersByTimeAsync(25);
      await expect(shutdown).resolves.toBe(false);
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a target poisoned when interrupted-save recovery is unverified", async () => {
    const children: FakeUtilityProcess[] = [];
    const broker = new SecureFileBroker({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    const pending = broker.perform(replacement);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit("exit", 1);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.emit("message", {
      type: "secure-file.recovery-result",
      ok: false,
    });
    children[1]!.emit("exit", 1);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      message: "The secure file service could not verify save recovery.",
    });
    await expect(broker.perform(replacement)).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      message: "A previous secure file operation has not been recovered safely.",
    });
    expect(children).toHaveLength(2);
    broker.close();
  });

  it("allows only verified recovery to clear a poisoned target", async () => {
    const children: FakeUtilityProcess[] = [];
    const broker = new SecureFileBroker({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    const interrupted = broker.perform(replacement);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit("exit", 1);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.emit("message", {
      type: "secure-file.recovery-result",
      ok: false,
    });
    children[1]!.emit("exit", 1);
    await expect(interrupted).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
    });

    const failedRecovery = broker.perform(recoveryRequest);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[2]!.emit("message", resultEvent({
      ok: false,
      code: "unavailable",
      message: "Recovery could not be verified.",
    }));
    children[2]!.emit("exit", 1);
    await expect(failedRecovery).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
    });
    await expect(broker.perform(request)).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
      message: "A previous secure file operation has not been recovered safely.",
    });
    expect(children).toHaveLength(3);

    const verifiedRecovery = broker.perform(recoveryRequest);
    await vi.waitFor(() => expect(children).toHaveLength(4));
    children[3]!.emit("message", resultEvent({
      ok: true,
      operation: "recover",
    }));
    children[3]!.emit("exit", 0);
    await expect(verifiedRecovery).resolves.toEqual({
      ok: true,
      operation: "recover",
    });

    const retried = broker.perform(request);
    await vi.waitFor(() => expect(children).toHaveLength(5));
    children[4]!.emit("message", resultEvent(success));
    children[4]!.emit("exit", 0);
    await expect(retried).resolves.toEqual(success);
    broker.close();
  });

  it("blocks public recovery until a timed-out recovery helper exits", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 25,
        killGraceMs: 10,
      });

      const interrupted = broker.perform(replacement);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(1);
      children[0]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(2);
      expect(children[1]!.postMessage).toHaveBeenCalledWith({
        type: "secure-file.recover",
        request: replacement,
      });

      await vi.advanceTimersByTimeAsync(35);
      expect(children[1]!.kill).toHaveBeenCalledOnce();
      await expect(interrupted).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
        message: "The secure file service could not verify save recovery.",
      });

      await expect(broker.perform(recoveryRequest)).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
        message: "A previous secure file operation has not been recovered safely.",
      });
      expect(children).toHaveLength(2);

      children[1]!.emit("exit", 1);
      const verifiedRecovery = broker.perform(recoveryRequest);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(3);
      children[2]!.emit("message", resultEvent({
        ok: true,
        operation: "recover",
      }));
      children[2]!.emit("exit", 0);
      await expect(verifiedRecovery).resolves.toEqual({
        ok: true,
        operation: "recover",
      });

      const retried = broker.perform(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(4);
      children[3]!.emit("message", resultEvent(success));
      children[3]!.emit("exit", 0);
      await expect(retried).resolves.toEqual(success);
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps timed-out recovery helpers inside the global concurrency bound", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 25,
        killGraceMs: 10,
      });
      const operations = Array.from({ length: 5 }, (_, index) => (
        broker.perform({
          ...replacement,
          path: `src/example-${index}.ts`,
        })
      ));
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(4);
      for (const child of children.slice(0, 4)) child.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(8);

      await vi.advanceTimersByTimeAsync(35);
      expect(children.slice(4, 8).every((child) => (
        child.kill.mock.calls.length === 1
      ))).toBe(true);
      expect(children).toHaveLength(8);

      children[4]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(9);
      children[8]!.emit("message", resultEvent(replacementSuccess));
      children[8]!.emit("exit", 0);

      await expect(Promise.all(operations)).resolves.toEqual([
        expect.objectContaining({ ok: false, code: "unavailable" }),
        expect.objectContaining({ ok: false, code: "unavailable" }),
        expect.objectContaining({ ok: false, code: "unavailable" }),
        expect.objectContaining({ ok: false, code: "unavailable" }),
        replacementSuccess,
      ]);
      for (const child of children.slice(5, 8)) child.emit("exit", 1);
      await expect(broker.shutdown()).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "a valid result followed by malformed output",
      messages: [
        { type: "secure-file.recovery-result", ok: true },
        { invalid: true },
      ],
      exitCode: 0,
      advanceBeforeExit: 0,
    },
    {
      name: "malformed output followed by a valid result",
      messages: [
        { invalid: true },
        { type: "secure-file.recovery-result", ok: true },
      ],
      exitCode: 0,
      advanceBeforeExit: 0,
    },
    {
      name: "a valid result followed by timeout",
      messages: [
        { type: "secure-file.recovery-result", ok: true },
      ],
      exitCode: 0,
      advanceBeforeExit: 25,
    },
    {
      name: "a valid result followed by a nonzero exit",
      messages: [
        { type: "secure-file.recovery-result", ok: true },
      ],
      exitCode: 1,
      advanceBeforeExit: 0,
    },
  ])("does not verify recovery after $name", async ({
    messages,
    exitCode,
    advanceBeforeExit,
  }) => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 25,
        killGraceMs: 10,
      });
      const pending = broker.perform(replacement);
      await vi.advanceTimersByTimeAsync(0);
      children[0]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(2);
      for (const message of messages) {
        children[1]!.emit("message", message);
      }
      if (advanceBeforeExit > 0) {
        await vi.advanceTimersByTimeAsync(advanceBeforeExit);
        expect(children[1]!.kill).toHaveBeenCalledOnce();
      }
      children[1]!.emit("exit", exitCode);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
        message: "The secure file service could not verify save recovery.",
      });
      await expect(broker.perform(request)).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
        message: "A previous secure file operation has not been recovered safely.",
      });
      await expect(broker.shutdown()).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("verifies recovery after a reported post-commit failure", async () => {
    const children: FakeUtilityProcess[] = [];
    const broker = new SecureFileBroker({
      spawn: () => {
        const child = new FakeUtilityProcess();
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    const pending = broker.perform(replacement);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit("message", {
      type: "secure-file.commit",
      phase: "started",
    });
    children[0]!.emit("message", {
      type: "secure-file.commit",
      phase: "finished",
    });
    children[0]!.emit("message", resultEvent(conflict));
    children[0]!.emit("exit", 1);

    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.emit("message", {
      type: "secure-file.recovery-result",
      ok: true,
    });
    children[1]!.emit("exit", 0);

    await expect(pending).resolves.toEqual(conflict);
    expect(children[1]!.postMessage).toHaveBeenCalledWith({
      type: "secure-file.recover",
      request: replacement,
    });
    broker.close();
  });

  it("does not deliver a cancelled replacement that spawns late", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          return utility(child);
        },
        timeoutMs: 100,
        killGraceMs: 10,
      });
      const controller = new AbortController();
      const first = broker.perform(replacement, controller.signal);
      await vi.waitFor(() => expect(children).toHaveLength(1));

      controller.abort();
      expect(children[0]!.kill).toHaveBeenCalledOnce();
      children[0]!.emit("spawn");
      expect(children[0]!.postMessage).not.toHaveBeenCalled();
      expect(children[0]!.kill).toHaveBeenCalledOnce();

      let firstSettled = false;
      void first.then(() => {
        firstSettled = true;
      });
      await vi.advanceTimersByTimeAsync(9);
      expect(firstSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      const blocked = broker.perform(replacement);
      await expect(blocked).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      const blockedRecovery = broker.perform(recoveryRequest);
      await expect(blockedRecovery).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(children).toHaveLength(1);

      const activeOthers = ["src/one.ts", "src/two.ts", "src/three.ts"].map(
        (path) => broker.perform({ ...request, path }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(4);
      for (const child of children.slice(1)) child.emit("spawn");

      const capacityWaiter = broker.perform({
        ...request,
        path: "src/four.ts",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(4);

      children[0]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(5);
      children[4]!.emit("spawn");
      for (const child of children.slice(1)) {
        child.emit("message", resultEvent(success));
        child.emit("exit", 0);
      }
      await expect(Promise.all([...activeOthers, capacityWaiter])).resolves
        .toEqual([success, success, success, success]);
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed helper output without trusting it", async () => {
    const child = new FakeUtilityProcess();
    const broker = new SecureFileBroker({
      spawn: () => {
        queueMicrotask(() => child.emit("spawn"));
        return utility(child);
      },
    });
    child.postMessage.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("message", resultEvent({
          ...success,
          metadata: { ...success.metadata, digest: "not-a-digest" },
        }));
        child.emit("exit", 1);
      });
    });

    await expect(broker.perform(request)).resolves.toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(child.kill).toHaveBeenCalledOnce();
    broker.close();
  });

  it("poisons a target until a killed helper confirms exit", async () => {
    vi.useFakeTimers();
    try {
      const children: FakeUtilityProcess[] = [];
      const broker = new SecureFileBroker({
        spawn: () => {
          const child = new FakeUtilityProcess();
          children.push(child);
          queueMicrotask(() => child.emit("spawn"));
          return utility(child);
        },
        timeoutMs: 25,
        killGraceMs: 10,
      });

      const first = broker.perform(request);
      const second = broker.perform(request);
      await vi.advanceTimersByTimeAsync(35);
      await expect(first).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      await expect(second).resolves.toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(children).toHaveLength(1);

      children[0]!.emit("exit", 1);
      const third = broker.perform(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(children).toHaveLength(2);
      children[1]!.emit("message", resultEvent(success));
      children[1]!.emit("exit", 0);
      await expect(third).resolves.toEqual(success);
      broker.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
