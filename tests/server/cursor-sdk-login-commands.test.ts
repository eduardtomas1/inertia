import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCursorSdkLoginCommandHandler } from "../../src/server/runtime/commands/cursor-sdk-login-commands";
import type { ServerEvent } from "../../src/shared/contracts";

function client(): WebSocket {
  return Object.assign(new EventEmitter(), { readyState: 1 }) as WebSocket;
}

function runtime() {
  const lifetime = new AbortController();
  const events: { socket: WebSocket; event: ServerEvent }[] = [];
  let resolve!: (result: { expiresAt: number }) => void;
  let reject!: (error: Error) => void;
  let onUrl!: (url: string) => void;
  let signal!: AbortSignal;
  const pending = new Promise<{ expiresAt: number }>((yes, no) => { resolve = yes; reject = no; });
  const login = vi.fn((publish: (url: string) => void, abort: AbortSignal) => {
    onUrl = publish;
    signal = abort;
    return pending;
  });
  const dependencies = {
    enabled: true, signal: lifetime.signal, login,
    status: vi.fn(async (_signal: AbortSignal) => ({ available: true, hasCredential: false, sdkVersion: "1.0.38" as const })),
    models: vi.fn(async (_signal: AbortSignal) => [{ id: "fixture-model", displayName: "Fixture model" }]),
    track: <T>(operation: () => Promise<T>) => operation(),
    send: (socket: WebSocket, event: ServerEvent) => { events.push({ socket, event }); },
  };
  return {
    dependencies, handle: createCursorSdkLoginCommandHandler(dependencies), lifetime,
    events, login, resolve, reject,
    url: (url: string) => onUrl(url),
    signal: () => signal,
  };
}

function start(requestId = randomUUID()) {
  return { type: "provider.cursor-sdk.login" as const, requestId };
}

function cancel(loginRequestId: string) {
  return { type: "provider.cursor-sdk.login.cancel" as const, requestId: randomUUID(), payload: { loginRequestId } };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("Cursor SDK login command ownership", () => {
  it.each([false, true])("quarantines login admission after unconfirmed cleanup, cancelled=%s", async (cancelled) => {
    vi.useFakeTimers();
    const run = runtime();
    const socket = client();
    const request = start();
    await run.handle(socket, request);
    if (cancelled) await run.handle(socket, cancel(request.requestId));
    run.reject(Object.assign(new Error("fixture-private-cleanup"), { code: "process-tree-termination-unconfirmed" }));
    await flush();
    expect(run.events.at(-1)?.event).toMatchObject({ status: cancelled ? "cancelled" : "failed" });
    await expect(run.handle(client(), start())).rejects.toThrow("cleanup is unconfirmed");
    await expect(run.handle(socket, { type: "provider.cursor-sdk.status", requestId: randomUUID() })).rejects.toThrow("cleanup is unconfirmed");
    await expect(run.handle(socket, { type: "provider.cursor-sdk.models", requestId: randomUUID() })).rejects.toThrow("cleanup is unconfirmed");
    await expect(run.handle(socket, cancel(request.requestId))).rejects.toThrow("cleanup is unconfirmed");
    await run.handle(socket, request);
    expect(run.login).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(run.events)).not.toContain("fixture-private-cleanup");
  });

  it.each(["status", "models"] as const)("quarantines %s discovery after unconfirmed cleanup", async (kind) => {
    const run = runtime();
    const socket = client();
    const command = { type: `provider.cursor-sdk.${kind}` as const, requestId: randomUUID() };
    const cause = Object.assign(new Error("fixture-private-cleanup"), { code: "process-tree-termination-unconfirmed" });
    run.dependencies[kind].mockRejectedValue(new Error("wrapped", { cause }));
    await expect(run.handle(socket, command)).rejects.toThrow("cleanup is unconfirmed");
    await expect(run.handle(client(), { ...command, requestId: randomUUID() })).rejects.toThrow("cleanup is unconfirmed");
    const other = kind === "models" ? "provider.cursor-sdk.status" : "provider.cursor-sdk.models";
    await expect(run.handle(socket, { type: other, requestId: randomUUID() })).rejects.toThrow("cleanup is unconfirmed");
    await expect(run.handle(socket, start())).rejects.toThrow("cleanup is unconfirmed");
    expect(run.dependencies[kind]).toHaveBeenCalledTimes(1);
    expect(run.events).toEqual([]);
  });

  it("shares concurrent discovery and publishes only credential presence", async () => {
    const run = runtime();
    let finish!: (result: Awaited<ReturnType<typeof run.dependencies.status>>) => void;
    run.dependencies.status.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = client();
    const second = client();
    const firstRequest = { type: "provider.cursor-sdk.status" as const, requestId: randomUUID() };
    const secondRequest = { type: "provider.cursor-sdk.status" as const, requestId: randomUUID() };
    const firstCheck = run.handle(first, firstRequest);
    const secondCheck = run.handle(second, secondRequest);
    await flush();
    await expect(run.handle(first, start())).rejects.toThrow("availability check");
    finish({ available: true, hasCredential: true, sdkVersion: "1.0.38", apiKey: "fixture-private-value",
      message: "fixture-private-error" } as Awaited<ReturnType<typeof run.dependencies.status>>);
    await Promise.all([firstCheck, secondCheck]);
    expect(run.dependencies.status).toHaveBeenCalledTimes(1);
    expect(run.events.map(({ event }) => event)).toEqual([firstRequest, secondRequest].map(({ requestId }) => ({
      type: "request.result", requestId,
      result: { kind: "provider.cursor-sdk.status", available: true, hasCredential: true, sdkVersion: "1.0.38" },
    })));
    expect(run.events.map(({ socket }) => socket)).toEqual([first, second]);
  });

  it("sanitizes discovery errors and does not probe during login", async () => {
    const run = runtime();
    const socket = client();
    const command = { type: "provider.cursor-sdk.status" as const, requestId: randomUUID() };
    run.dependencies.status.mockRejectedValue(new Error("fixture-private-error"));
    await expect(run.handle(socket, command)).rejects.toThrow("availability could not be checked");
    await run.handle(socket, start());
    await expect(run.handle(socket, command)).rejects.toThrow("sign-in to finish");
    expect(run.dependencies.status).toHaveBeenCalledTimes(1);
    run.reject(new Error("cancelled"));
    await flush();
  });

  it("returns only catalogue identities and serializes model discovery with status", async () => {
    const run = runtime();
    const socket = client();
    let finish!: (result: Awaited<ReturnType<typeof run.dependencies.status>>) => void;
    run.dependencies.status.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const status = run.handle(socket, { type: "provider.cursor-sdk.status", requestId: randomUUID() });
    await flush();
    const models = { type: "provider.cursor-sdk.models" as const, requestId: randomUUID() };
    await expect(run.handle(socket, models)).rejects.toThrow("availability check");
    expect(run.dependencies.models).not.toHaveBeenCalled();
    finish({ available: true, hasCredential: true, sdkVersion: "1.0.38" });
    await status;
    run.dependencies.models.mockResolvedValue([{ id: "catalogue-id", displayName: "Catalogue model",
      apiKey: "fixture-private-value" } as { id: string; displayName: string }]);
    await run.handle(socket, models);
    expect(run.events.at(-1)?.event).toEqual({ type: "request.result", requestId: models.requestId,
      result: { kind: "provider.cursor-sdk.models", models: [{ id: "catalogue-id", displayName: "Catalogue model" }] } });
    expect(JSON.stringify(run.events.map(({ event }) => event))).not.toContain("fixture-private-value");
  });

  it("rejects duplicate or oversized provider catalogues without publishing them", async () => {
    const run = runtime();
    const socket = client();
    const command = { type: "provider.cursor-sdk.models" as const, requestId: randomUUID() };
    const model = { id: "fixture-model", displayName: "Fixture" };
    run.dependencies.models.mockResolvedValue([model, model]);
    await expect(run.handle(socket, command)).rejects.toThrow("models could not be loaded");
    run.dependencies.models.mockResolvedValue(Array.from({ length: 513 }, (_, index) => ({ ...model, id: String(index) })));
    await expect(run.handle(socket, command)).rejects.toThrow("models could not be loaded");
    expect(run.events).toEqual([]);
  });

  it("deduplicates models, aborts at the deadline and retains the probe until cleanup settles", async () => {
    vi.useFakeTimers();
    const run = runtime();
    const socket = client();
    let signal!: AbortSignal;
    let finish!: (result: { id: string; displayName: string }[]) => void;
    run.dependencies.models.mockImplementation((value) => {
      signal = value;
      return new Promise((resolve) => { finish = resolve; });
    });
    const command = { type: "provider.cursor-sdk.models" as const, requestId: randomUUID() };
    const first = run.handle(socket, command).catch((error: unknown) => error);
    const second = run.handle(client(), { ...command, requestId: randomUUID() }).catch((error: unknown) => error);
    await flush();
    expect(run.dependencies.models).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(signal.aborted).toBe(true);
    await expect(run.handle(socket, start())).rejects.toThrow("availability check");
    finish([{ id: "late-model", displayName: "Late model" }]);
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    expect(run.events).toEqual([]);
    await expect(run.handle(socket, { type: "provider.cursor-sdk.status", requestId: randomUUID() })).resolves.toBe("handled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts model discovery on shutdown and suppresses a late result", async () => {
    const run = runtime();
    const socket = client();
    let signal!: AbortSignal;
    let finish!: (result: { id: string; displayName: string }[]) => void;
    run.dependencies.models.mockImplementation((value) => {
      signal = value;
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = run.handle(socket, { type: "provider.cursor-sdk.models", requestId: randomUUID() }).catch((error: unknown) => error);
    await flush();
    run.lifetime.abort();
    expect(signal.aborted).toBe(true);
    finish([{ id: "late-model", displayName: "Late model" }]);
    expect(await pending).toBeInstanceOf(Error);
    expect(run.events).toEqual([]);
  });

  it("acknowledges immediately and publishes only safe fields to the requesting window", async () => {
    const run = runtime();
    const socket = client();
    const request = start();
    expect(await run.handle(socket, request)).toBe("handled");
    expect(run.events[0]).toEqual({ socket, event: { type: "request.ok", requestId: request.requestId } });
    run.url("https://cursor.com/login?request=fixture");
    const expiresAt = Date.now() + 60_000;
    run.resolve({ expiresAt, apiKey: "fixture-private-value" } as { expiresAt: number });
    await flush();
    expect(run.events.at(-1)).toEqual({ socket, event: {
      type: "provider.cursor-sdk.login.updated", loginRequestId: request.requestId, status: "authenticated", expiresAt,
    } });
    expect(JSON.stringify(run.events.map(({ event }) => event))).not.toContain("fixture-private-value");
    expect(run.events.every((entry) => entry.socket === socket)).toBe(true);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("replays active and settled acknowledgements without another login", async () => {
    const run = runtime();
    const socket = client();
    const request = start();
    await run.handle(socket, request);
    run.url("https://cursor.com/login?request=fixture");
    await run.handle(socket, request);
    expect(run.events.at(-1)?.event).toMatchObject({ status: "waiting" });
    run.resolve({ expiresAt: Date.now() + 60_000 });
    await flush();
    await run.handle(socket, request);
    expect(run.events.at(-1)?.event).toMatchObject({ status: "authenticated" });
    expect(run.login).toHaveBeenCalledTimes(1);
  });

  it("rejects another window or stale request and holds cancellation until settlement", async () => {
    const run = runtime();
    const socket = client();
    const other = client();
    const request = start();
    await run.handle(socket, request);
    await expect(run.handle(other, cancel(request.requestId))).rejects.toThrow("this window");
    await expect(run.handle(socket, cancel(randomUUID()))).rejects.toThrow("this window");
    expect(run.signal().aborted).toBe(false);
    await run.handle(socket, cancel(request.requestId));
    expect(run.signal().aborted).toBe(true);
    await expect(run.handle(other, start())).rejects.toThrow("still active");
    run.resolve({ expiresAt: Date.now() + 60_000 });
    await flush();
    expect(run.events.at(-1)?.event).toMatchObject({ status: "cancelled" });
    await run.handle(socket, cancel(request.requestId));
    await run.handle(other, start());
    await flush();
    expect(run.login).toHaveBeenCalledTimes(2);
  });

  it("aborts on disconnect without sending more events to the closed client", async () => {
    const run = runtime();
    const socket = client();
    await run.handle(socket, start());
    const count = run.events.length;
    socket.emit("close");
    expect(run.signal().aborted).toBe(true);
    run.reject(new Error("fixture-private-value"));
    await flush();
    expect(run.events).toHaveLength(count);
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("cancels on runtime shutdown and refuses later admission", async () => {
    const run = runtime();
    const socket = client();
    await run.handle(socket, start());
    run.lifetime.abort();
    expect(run.signal().aborted).toBe(true);
    run.reject(new Error("fixture-private-value"));
    await flush();
    expect(run.events.at(-1)?.event).toMatchObject({ status: "cancelled" });
    await expect(run.handle(socket, start())).rejects.toThrow("unavailable");
  });

  it("expires a pending login and keeps its slot until provider cleanup finishes", async () => {
    vi.useFakeTimers();
    const run = runtime();
    const socket = client();
    await run.handle(socket, start());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run.signal().aborted).toBe(true);
    await expect(run.handle(socket, start())).rejects.toThrow("still active");
    run.reject(new Error("deadline"));
    await flush();
    expect(run.events.at(-1)?.event).toMatchObject({ status: "expired" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["http://cursor.com/login", "https://cursor.com.attacker.invalid/login", "https://name:pass@cursor.com/login"])(
    "refuses an invalid login URL without publishing it: %s", async (url) => {
      const run = runtime();
      const socket = client();
      await run.handle(socket, start());
      expect(() => run.url(url)).toThrow("invalid URL");
      expect(run.signal().aborted).toBe(true);
      run.resolve({ expiresAt: Date.now() + 60_000 });
      await flush();
      expect(run.events.at(-1)?.event).toMatchObject({ status: "failed" });
      expect(run.events.some(({ event }) => "loginUrl" in event)).toBe(false);
    },
  );

  it("withholds provider errors and rejects invalid completion expiry", async () => {
    const run = runtime();
    const socket = client();
    await run.handle(socket, start());
    run.resolve({ expiresAt: Number.NaN });
    await flush();
    expect(run.events.at(-1)?.event).toMatchObject({ status: "failed" });
    const failed = runtime();
    await failed.handle(socket, start());
    failed.reject(new Error("fixture-private-value"));
    await flush();
    expect(failed.events.at(-1)?.event).toMatchObject({ status: "failed" });
    expect(JSON.stringify(failed.events.map(({ event }) => event))).not.toContain("fixture-private-value");
  });

  it("rejects detached-window and disabled-runtime admission before calling the provider", async () => {
    const run = runtime();
    const socket = client();
    await expect(run.handle(socket, start(), { kind: "detached-chat", conversationId: randomUUID(), clientId: randomUUID() }))
      .rejects.toThrow("main window");
    run.dependencies.enabled = false;
    await expect(run.handle(socket, start())).rejects.toThrow("unavailable");
    expect(run.login).not.toHaveBeenCalled();
  });

  it("does not start a login for a socket that already disconnected", async () => {
    const run = runtime();
    const socket = Object.assign(new EventEmitter(), { readyState: 3 }) as WebSocket;
    await expect(run.handle(socket, start())).rejects.toThrow("unavailable");
    expect(run.login).not.toHaveBeenCalled();
  });

  it("releases ownership when runtime operation tracking refuses admission", async () => {
    const run = runtime();
    run.dependencies.track = async () => { throw new Error("runtime is closing"); };
    const socket = client();
    await run.handle(socket, start());
    await flush();
    expect(run.events.at(-1)?.event).toMatchObject({ status: "failed" });
    expect(socket.listenerCount("close")).toBe(0);
    expect(run.login).not.toHaveBeenCalled();
    await expect(run.handle(socket, start())).resolves.toBe("handled");
    await flush();
  });
});
