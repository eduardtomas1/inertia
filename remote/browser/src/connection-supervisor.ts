const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_CAP_MS = 16_000;

export type RemoteConnectionFailureKind = "transient" | "terminal";

export class RemoteConnectionFailure extends Error {
  readonly name = "RemoteConnectionFailure";

  constructor(
    message: string,
    readonly kind: RemoteConnectionFailureKind,
    readonly code: string,
  ) {
    super(message);
  }
}

export type RemoteConnectionPhase =
  | "idle"
  | "offline"
  | "connecting"
  | "backoff"
  | "online"
  | "terminal";

export interface RemoteConnectionSnapshot {
  phase: RemoteConnectionPhase;
  generation: number;
  attempt: number;
  retryAt: number | null;
  failure: RemoteConnectionFailure | null;
}

export interface BrowserConnectionSupervisorOptions {
  attempt(generation: number): Promise<void>;
  invalidate(message: string): void;
  foreground(generation: number): void;
  expired(): Promise<void>;
  expiresAt(): string | null;
  state(snapshot: RemoteConnectionSnapshot): void;
  now?: () => number;
  random?: () => number;
  online?: () => boolean;
  retryBaseMs?: number;
  retryCapMs?: number;
}

/**
 * Owns browser transport generations and every automatic retry. The driver
 * performs exactly one connection attempt and never schedules itself.
 */
export class BrowserConnectionSupervisor {
  private generation = 0;
  private failureCount = 0;
  private activeAttempt: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private wakePending = false;
  private desired = false;
  private connected = false;
  private terminalBlocked = false;
  private listenersAttached = false;
  private snapshot: RemoteConnectionSnapshot = {
    phase: "idle",
    generation: 0,
    attempt: 0,
    retryAt: null,
    failure: null,
  };

  private readonly now: () => number;
  private readonly random: () => number;
  private readonly online: () => boolean;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;

  constructor(private readonly options: BrowserConnectionSupervisorOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.online = options.online ?? (() =>
      typeof navigator === "undefined" || navigator.onLine !== false);
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
  }

  current(): RemoteConnectionSnapshot {
    return this.snapshot;
  }

  owns(generation: number): boolean {
    return this.desired && generation === this.generation;
  }

  start(): Promise<void> {
    this.desired = true;
    this.terminalBlocked = false;
    this.failureCount = 0;
    this.attachListeners();
    this.scheduleExpiry();
    return this.wake(true);
  }

  retryNow(): Promise<void> {
    if (!this.desired) this.desired = true;
    this.terminalBlocked = false;
    this.attachListeners();
    this.failureCount = 0;
    this.clearRetry();
    this.scheduleExpiry();
    return this.wake(true);
  }

  grantUpdated(): void {
    if (!this.desired) return;
    this.scheduleExpiry();
  }

  stop(message = "Remote Companion disconnected."): void {
    this.desired = false;
    this.connected = false;
    this.terminalBlocked = false;
    this.generation += 1;
    this.clearRetry();
    this.clearExpiry();
    this.options.invalidate(message);
    this.publish("idle", null, null);
  }

  transportClosed(
    generation: number,
    failure: RemoteConnectionFailure,
  ): void {
    if (!this.owns(generation)) return;
    this.connected = false;
    // Invalidate the attempt/lease before its asynchronous tail can publish a
    // stale success over this failure.
    this.generation += 1;
    this.options.invalidate(failure.message);
    if (failure.kind === "terminal") {
      this.terminalBlocked = true;
      this.clearRetry();
      this.publish("terminal", failure, null);
      return;
    }
    this.scheduleRetry(failure);
  }

  private wake(resetBackoff: boolean): Promise<void> {
    if (!this.desired) return Promise.resolve();
    if (this.terminalBlocked) return Promise.resolve();
    if (this.grantExpired()) {
      this.expire();
      return Promise.resolve();
    }
    if (!this.online()) {
      this.connected = false;
      this.clearRetry();
      this.options.invalidate("This browser is offline. Cached data may be stale.");
      this.publish("offline", null, null);
      return Promise.resolve();
    }
    if (this.connected) {
      this.options.foreground(this.generation);
      return Promise.resolve();
    }
    if (this.activeAttempt) {
      this.wakePending = true;
      return this.activeAttempt;
    }
    if (resetBackoff) this.failureCount = 0;
    this.clearRetry();
    const generation = ++this.generation;
    const attempt = this.failureCount + 1;
    this.publish("connecting", null, null, attempt);
    const running = this.runAttempt(generation, attempt).finally(() => {
      if (this.activeAttempt === running) this.activeAttempt = null;
      if (this.connected) this.wakePending = false;
      if (this.wakePending && this.desired && !this.connected) {
        this.wakePending = false;
        queueMicrotask(() => void this.wake(false));
      }
    });
    this.activeAttempt = running;
    return running;
  }

  private async runAttempt(generation: number, attempt: number): Promise<void> {
    try {
      await this.options.attempt(generation);
      if (!this.owns(generation)) return;
      this.connected = true;
      this.publish("online", null, null, attempt);
    } catch (error) {
      if (!this.owns(generation)) return;
      this.connected = false;
      const failure = normalizeRemoteConnectionFailure(error);
      this.options.invalidate(failure.message);
      if (failure.kind === "terminal") {
        this.terminalBlocked = true;
        this.publish("terminal", failure, null, attempt);
      } else {
        this.scheduleRetry(failure, attempt);
      }
    }
  }

  private scheduleRetry(
    failure: RemoteConnectionFailure,
    attempt = this.failureCount + 1,
  ): void {
    if (!this.desired) return;
    if (!this.online()) {
      this.publish("offline", failure, null, attempt);
      return;
    }
    this.failureCount += 1;
    const delay = remoteRetryDelayMs(
      this.failureCount,
      this.random(),
      this.retryBaseMs,
      this.retryCapMs,
    );
    const retryAt = this.now() + delay;
    this.publish("backoff", failure, retryAt, attempt);
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.wake(false);
    }, delay);
  }

  private scheduleExpiry(): void {
    this.clearExpiry();
    const expiresAt = this.options.expiresAt();
    if (!expiresAt) return;
    const remaining = Date.parse(expiresAt) - this.now();
    if (remaining <= 0) {
      this.expire();
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expire();
    }, Math.min(remaining, 2_147_483_647));
  }

  private grantExpired(): boolean {
    const expiresAt = this.options.expiresAt();
    return expiresAt !== null && Date.parse(expiresAt) <= this.now();
  }

  private expire(): void {
    if (!this.desired) return;
    this.desired = false;
    this.connected = false;
    this.terminalBlocked = true;
    this.generation += 1;
    this.clearRetry();
    this.clearExpiry();
    const failure = new RemoteConnectionFailure(
      "This device grant expired. Pair it again.",
      "terminal",
      "grant-expired",
    );
    this.options.invalidate(failure.message);
    this.publish("terminal", failure, null);
    void this.options.expired();
  }

  private readonly onOnline = (): void => {
    this.failureCount = 0;
    void this.wake(true);
  };

  private readonly onOffline = (): void => {
    if (!this.desired) return;
    this.connected = false;
    this.generation += 1;
    this.clearRetry();
    this.options.invalidate("This browser is offline. Cached data may be stale.");
    this.publish("offline", null, null);
  };

  private readonly onForeground = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    this.failureCount = 0;
    void this.wake(true);
  };

  private attachListeners(): void {
    if (this.listenersAttached || typeof window === "undefined") return;
    this.listenersAttached = true;
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("focus", this.onForeground);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onForeground);
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private publish(
    phase: RemoteConnectionPhase,
    failure: RemoteConnectionFailure | null,
    retryAt: number | null,
    attempt = this.snapshot.attempt,
  ): void {
    this.snapshot = {
      phase,
      generation: this.generation,
      attempt,
      retryAt,
      failure,
    };
    this.options.state(this.snapshot);
  }
}

export function normalizeRemoteConnectionFailure(
  error: unknown,
): RemoteConnectionFailure {
  if (error instanceof RemoteConnectionFailure) return error;
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 240)
    : "The desktop is offline.";
  return new RemoteConnectionFailure(message, "transient", "transport");
}

export function remoteRetryDelayMs(
  failureCount: number,
  random: number,
  baseMs = DEFAULT_RETRY_BASE_MS,
  capMs = DEFAULT_RETRY_CAP_MS,
): number {
  const exponential = Math.min(
    capMs,
    baseMs * 2 ** Math.max(0, failureCount - 1),
  );
  const jitter = 0.75 + Math.max(0, Math.min(1, random)) * 0.5;
  return Math.max(1, Math.min(capMs, Math.round(exponential * jitter)));
}
