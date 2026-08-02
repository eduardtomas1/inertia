import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserConnectionSupervisor,
  RemoteConnectionFailure,
  remoteRetryDelayMs,
  type RemoteConnectionSnapshot,
} from "../remote/browser/src/connection-supervisor";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Remote Companion browser connection supervisor", () => {
  it("uses capped exponential delays with bounded jitter", () => {
    expect(remoteRetryDelayMs(1, 0)).toBe(750);
    expect(remoteRetryDelayMs(1, 1)).toBe(1_250);
    expect(remoteRetryDelayMs(2, 0.5)).toBe(2_000);
    expect(remoteRetryDelayMs(20, 1)).toBe(16_000);
  });

  it("keeps exactly one attempt active and retries transient failures", async () => {
    vi.useFakeTimers();
    let rejectFirst = (): void => undefined;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = () => reject(new RemoteConnectionFailure(
        "first attempt failed",
        "transient",
        "transport",
      ));
    });
    const attempt = vi.fn()
      .mockImplementationOnce(async () => await first)
      .mockRejectedValueOnce(new RemoteConnectionFailure(
        "relay unavailable",
        "transient",
        "relay",
      ))
      .mockResolvedValueOnce(undefined);
    const states: RemoteConnectionSnapshot[] = [];
    const supervisor = new BrowserConnectionSupervisor({
      attempt,
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired: vi.fn(async () => undefined),
      expiresAt: () => new Date(Date.now() + 60_000).toISOString(),
      state: (value) => states.push(value),
      random: () => 0.5,
    });

    const starting = supervisor.start();
    const overlapping = supervisor.retryNow();
    expect(attempt).toHaveBeenCalledTimes(1);
    rejectFirst();
    await Promise.all([starting, overlapping]);
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));
    expect(states.at(-1)?.phase).toBe("backoff");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(3));
    expect(states.at(-1)?.phase).toBe("online");
  });

  it("resets backoff after recovery before a later transport drop", async () => {
    vi.useFakeTimers();
    const transient = () => new RemoteConnectionFailure(
      "relay unavailable",
      "transient",
      "relay",
    );
    const attempt = vi.fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce(undefined);
    const supervisor = new BrowserConnectionSupervisor({
      attempt,
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired: vi.fn(async () => undefined),
      expiresAt: () => null,
      state: vi.fn(),
      now: () => Date.now(),
      random: () => 0.5,
    });

    await supervisor.start();
    expect(supervisor.current().retryAt).toBe(Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.current().retryAt).toBe(Date.now() + 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(supervisor.current().phase).toBe("online");

    supervisor.transportClosed(
      supervisor.current().generation,
      transient(),
    );
    expect(supervisor.current()).toMatchObject({
      phase: "backoff",
      retryAt: Date.now() + 1_000,
    });
  });

  it("suppresses stale attempts across offline and online generations", async () => {
    let online = true;
    let release = (): void => undefined;
    const stale = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt = vi.fn()
      .mockImplementationOnce(async () => await stale)
      .mockResolvedValueOnce(undefined);
    const states: RemoteConnectionSnapshot[] = [];
    const supervisor = new BrowserConnectionSupervisor({
      attempt,
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired: vi.fn(async () => undefined),
      expiresAt: () => new Date(Date.now() + 60_000).toISOString(),
      state: (value) => states.push(value),
      online: () => online,
    });

    const starting = supervisor.start();
    online = false;
    (supervisor as unknown as { onOffline(): void }).onOffline();
    online = true;
    (supervisor as unknown as { onOnline(): void }).onOnline();
    expect(attempt).toHaveBeenCalledTimes(1);
    release();
    await starting;
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));
    expect(states.at(-1)?.phase).toBe("online");
    expect(states.filter(({ phase }) => phase === "online")).toHaveLength(1);
  });

  it("does not auto-retry terminal failures, including on foreground", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const attempt = vi.fn(async () => {
      throw new RemoteConnectionFailure(
        "protocol mismatch",
        "terminal",
        "protocol-mismatch",
      );
    });
    const states: RemoteConnectionSnapshot[] = [];
    const supervisor = new BrowserConnectionSupervisor({
      attempt,
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired: vi.fn(async () => undefined),
      expiresAt: () => expiresAt,
      state: (value) => states.push(value),
    });

    await supervisor.start();
    expect(states.at(-1)?.phase).toBe("terminal");
    (supervisor as unknown as { onForeground(): void }).onForeground();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("keeps trusted local expiry active after a terminal transport failure", async () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    const expired = vi.fn(async () => undefined);
    const supervisor = new BrowserConnectionSupervisor({
      attempt: vi.fn(async () => {
        throw new RemoteConnectionFailure(
          "protocol mismatch",
          "terminal",
          "protocol-mismatch",
        );
      }),
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired,
      expiresAt: () => expiresAt,
      state: vi.fn(),
    });

    await supervisor.start();
    expect(supervisor.current()).toMatchObject({
      phase: "terminal",
      failure: { code: "protocol-mismatch" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.current()).toMatchObject({
      phase: "terminal",
      failure: { code: "grant-expired" },
    });
    expect(expired).toHaveBeenCalledOnce();
  });

  it("wakes transient backoff immediately when the browser resumes", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn()
      .mockRejectedValueOnce(new RemoteConnectionFailure(
        "desktop asleep",
        "transient",
        "transport",
      ))
      .mockResolvedValueOnce(undefined);
    const supervisor = new BrowserConnectionSupervisor({
      attempt,
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired: vi.fn(async () => undefined),
      expiresAt: () => new Date(Date.now() + 60_000).toISOString(),
      state: vi.fn(),
      random: () => 0.5,
    });

    await supervisor.start();
    expect(supervisor.current().phase).toBe("backoff");
    (supervisor as unknown as { onForeground(): void }).onForeground();
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(2));
    expect(supervisor.current().phase).toBe("online");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("expires an active grant without waiting for transport activity", async () => {
    vi.useFakeTimers();
    const expired = vi.fn(async () => undefined);
    const expiresAt = new Date(Date.now() + 1_000).toISOString();
    const supervisor = new BrowserConnectionSupervisor({
      attempt: vi.fn(async () => undefined),
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired,
      expiresAt: () => expiresAt,
      state: vi.fn(),
    });

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(supervisor.current()).toMatchObject({
      phase: "terminal",
      failure: { code: "grant-expired", kind: "terminal" },
    });
    expect(expired).toHaveBeenCalledOnce();
  });

  it("reschedules expiry when an authenticated grant changes", async () => {
    vi.useFakeTimers();
    let expiresAt = new Date(Date.now() + 60_000).toISOString();
    const expired = vi.fn(async () => undefined);
    const supervisor = new BrowserConnectionSupervisor({
      attempt: vi.fn(async () => undefined),
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired,
      expiresAt: () => expiresAt,
      state: vi.fn(),
    });

    await supervisor.start();
    expiresAt = new Date(Date.now() + 500).toISOString();
    supervisor.grantUpdated();
    await vi.advanceTimersByTimeAsync(500);

    expect(supervisor.current()).toMatchObject({
      phase: "terminal",
      failure: { code: "grant-expired" },
    });
    expect(expired).toHaveBeenCalledOnce();
  });

  it("rechecks long grants after the platform timer cap", async () => {
    vi.useFakeTimers();
    const maximumTimer = 2_147_483_647;
    const expired = vi.fn(async () => undefined);
    const expiresAt = new Date(Date.now() + maximumTimer + 5_000).toISOString();
    const supervisor = new BrowserConnectionSupervisor({
      attempt: vi.fn(async () => undefined),
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired,
      expiresAt: () => expiresAt,
      state: vi.fn(),
    });

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(maximumTimer);
    expect(supervisor.current().phase).toBe("online");
    expect(expired).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(supervisor.current().phase).toBe("terminal");
    expect(expired).toHaveBeenCalledOnce();
  });

  it("preserves a terminal failure across offline and online signals", async () => {
    let online = true;
    const attempt = vi.fn(async () => {
      throw new RemoteConnectionFailure(
        "protocol mismatch",
        "terminal",
        "protocol-mismatch",
      );
    });
    const states: RemoteConnectionSnapshot[] = [];
    const supervisor = new BrowserConnectionSupervisor({
      attempt,
      invalidate: vi.fn(),
      foreground: vi.fn(),
      expired: vi.fn(async () => undefined),
      expiresAt: () => new Date(Date.now() + 60_000).toISOString(),
      state: (value) => states.push(value),
      online: () => online,
    });

    await supervisor.start();
    const terminal = supervisor.current();
    online = false;
    (supervisor as unknown as { onOffline(): void }).onOffline();
    online = true;
    (supervisor as unknown as { onOnline(): void }).onOnline();

    expect(supervisor.current()).toEqual(terminal);
    expect(states.at(-1)).toEqual(terminal);
    expect(attempt).toHaveBeenCalledOnce();
  });
});
