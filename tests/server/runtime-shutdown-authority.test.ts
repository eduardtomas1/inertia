import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startRuntime, type RunningRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import type { ServerEvent } from "../../src/shared/contracts";
import { connectRuntime } from "../support/runtime-event-queue";
import { startTestRuntime } from "../support/test-runtime";

const runtimeIdentity = {
  runtimeGenerationId: "00000000-0000-4000-8000-000000000001:1",
  systemBootId: "test:00000000-0000-4000-8000-000000000001",
} as const;
const directories: string[] = [];
const runtimes: RunningRuntime[] = [];

async function workspace(): Promise<{ data: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "inertia-shutdown-authority-"));
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  await Promise.all([mkdir(data), mkdir(workspace)]);
  directories.push(root);
  return { data, workspace };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.allSettled(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("runtime shutdown authority", () => {
  it("holds update admission while draining an admitted command and supports exact rollback", async () => {
    const paths = await workspace();
    const commandGate = deferred();
    const beforeCommand = vi.fn(() => commandGate.promise);
    const runtime = await startTestRuntime({
      dataDirectory: paths.data,
      defaultWorkspacePath: paths.workspace,
      enableProviders: false,
      testOnlyBeforeRuntimeCommand: beforeCommand,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    const client = await connectRuntime(runtime.websocketUrl);
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    client.socket.send(JSON.stringify({
      type: "settings.update",
      requestId: randomUUID(),
      payload: { theme: "dark" },
    }));
    await vi.waitFor(() => expect(beforeCommand).toHaveBeenCalledOnce());

    const operationId = randomUUID();
    let settled = false;
    const preparing = runtime.prepareForUpdate(operationId).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const rejectedRequestId = randomUUID();
    client.socket.send(JSON.stringify({
      type: "settings.update",
      requestId: rejectedRequestId,
      payload: { theme: "light" },
    }));
    const rejected = await client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.error" }> =>
        event.type === "request.error" && event.requestId === rejectedRequestId,
    );
    expect(rejected.message).toContain("application update");

    commandGate.resolve();
    await expect(preparing).resolves.toEqual({ ready: true });
    expect(runtime.releaseUpdatePreparation(randomUUID())).toBe(false);
    expect(runtime.releaseUpdatePreparation(operationId)).toBe(true);

    const acceptedRequestId = randomUUID();
    client.socket.send(JSON.stringify({
      type: "settings.update",
      requestId: acceptedRequestId,
      payload: { theme: "system" },
    }));
    await expect(client.events.next(
      (event): event is Extract<ServerEvent, { type: "request.ok" }> =>
        event.type === "request.ok" && event.requestId === acceptedRequestId,
    )).resolves.toMatchObject({ requestId: acceptedRequestId });
  });

  it("reports provider refresh as a sanitized update blocker and releases admission", async () => {
    const paths = await workspace();
    const refreshGate = deferred();
    const beforeRefresh = vi.fn(() => refreshGate.promise);
    const runtime = await startTestRuntime({
      dataDirectory: paths.data,
      defaultWorkspacePath: paths.workspace,
      enableProviders: true,
      testOnlyProviderRefresh: beforeRefresh,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    await vi.waitFor(() => expect(beforeRefresh).toHaveBeenCalledOnce());

    await expect(runtime.prepareForUpdate(randomUUID())).resolves.toEqual({
      ready: false,
      blocker: "provider-refresh",
    });
    refreshGate.resolve();
  });

  it("does not close while an admitted command is still inside its owned barrier", async () => {
    const paths = await workspace();
    const commandGate = deferred();
    const beforeCommand = vi.fn(() => commandGate.promise);
    const runtime = await startTestRuntime({
      dataDirectory: paths.data,
      defaultWorkspacePath: paths.workspace,
      enableProviders: false,
      testOnlyBeforeRuntimeCommand: beforeCommand,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    const client = await connectRuntime(runtime.websocketUrl);
    await client.events.next(
      (event): event is Extract<ServerEvent, { type: "server.welcome" }> =>
        event.type === "server.welcome",
    );
    client.socket.send(JSON.stringify({
      type: "settings.update",
      requestId: randomUUID(),
      payload: { theme: "dark" },
    }));
    await vi.waitFor(() => expect(beforeCommand).toHaveBeenCalledOnce());

    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    commandGate.resolve();
    await closing;
    expect(closed).toBe(true);
    runtimes.splice(runtimes.indexOf(runtime), 1);
  });

  it("drains startup provider refresh and prevents maintenance from starting after close", async () => {
    const paths = await workspace();
    const refreshGate = deferred();
    const beforeRefresh = vi.fn(() => refreshGate.promise);
    const runtime = await startTestRuntime({
      dataDirectory: paths.data,
      defaultWorkspacePath: paths.workspace,
      enableProviders: true,
      testOnlyProviderRefresh: beforeRefresh,
      ...runtimeIdentity,
    });
    runtimes.push(runtime);
    await vi.waitFor(() => expect(beforeRefresh).toHaveBeenCalledOnce());

    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    refreshGate.resolve();
    await closing;
    expect(beforeRefresh).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
    runtimes.splice(runtimes.indexOf(runtime), 1);
  });

  it("rejects initialization without mutating data when the supervisor lease is missing", async () => {
    const paths = await workspace();
    const databasePath = join(paths.data, "inertia.sqlite");
    const seed = new RuntimeStore(databasePath, paths.workspace, {
      recoverInterruptedRuns: false,
    });
    const project = seed.createProject("Safety project", paths.workspace);
    seed.createConversation(project.id, "Safety chat");
    const before = seed.shellSnapshot();
    seed.close();
    await expect(startRuntime({
      dataDirectory: paths.data,
      defaultWorkspacePath: paths.workspace,
      enableProviders: true,
      ...runtimeIdentity,
    })).rejects.toThrow("Runtime startup is blocked");

    const reopened = new RuntimeStore(databasePath, paths.workspace, {
      recoverInterruptedRuns: false,
    });
    const after = reopened.shellSnapshot();
    reopened.close();
    expect(after.activeConversationId).toBe(before.activeConversationId);
    expect(after.conversations).toEqual(before.conversations);
  });

  it("does not promise reboot recovery when boot evidence is unavailable", async () => {
    const paths = await workspace();
    const failure = await startRuntime({
      dataDirectory: paths.data,
      defaultWorkspacePath: paths.workspace,
      enableProviders: true,
      runtimeGenerationId: runtimeIdentity.runtimeGenerationId,
      systemBootId: "unavailable",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("retry exact cleanup");
    expect(message).toContain("contact support");
    expect(message).not.toMatch(/restart|reboot/iu);
  });
});
