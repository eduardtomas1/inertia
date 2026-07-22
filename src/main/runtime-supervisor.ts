import type { UtilityProcess } from "electron";

import type { RuntimeConnection } from "../shared/desktop.js";
import {
  parseRuntimeWorkerEvent,
  type RuntimeWorkerCommand,
  type RuntimeWorkerOptions,
} from "./runtime-process-protocol.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_STABLE_UPTIME_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 1_000;
const INITIAL_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 8_000;

type Timer = ReturnType<typeof setTimeout>;

interface RuntimeProcessRecord {
  child: UtilityProcess;
  generation: number;
  ready: boolean;
  acceptingReady: boolean;
  reportedFailure: string | null;
}

export type RuntimeSupervisorPhase =
  | "idle"
  | "starting"
  | "ready"
  | "restarting"
  | "stopping"
  | "stopped";

export interface RuntimeSupervisorSnapshot {
  phase: RuntimeSupervisorPhase;
  generation: number;
  pid: number | null;
  websocketUrl: string | null;
  restartAttempt: number;
  restartScheduled: boolean;
  lastError: string | null;
}

export interface RuntimeSupervisorOptions {
  spawn: () => UtilityProcess;
  workerOptions: RuntimeWorkerOptions;
  startupTimeoutMs?: number;
  stableUptimeMs?: number;
  shutdownGraceMs?: number;
  forceKillWaitMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  forceKill?: (pid: number) => void;
  onStateChange?: (snapshot: RuntimeSupervisorSnapshot) => void;
}

export function runtimeRestartDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(Math.trunc(attempt), 30));
  return Math.min(INITIAL_RESTART_DELAY_MS * 2 ** exponent, MAX_RESTART_DELAY_MS);
}

export class RuntimeSupervisor {
  private readonly spawnProcess: RuntimeSupervisorOptions["spawn"];
  private readonly workerOptions: RuntimeWorkerOptions;
  private readonly startupTimeoutMs: number;
  private readonly stableUptimeMs: number;
  private readonly shutdownGraceMs: number;
  private readonly forceKillWaitMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly forceKill: (pid: number) => void;
  private readonly onStateChange?: RuntimeSupervisorOptions["onStateChange"];
  private current: RuntimeProcessRecord | null = null;
  private phase: RuntimeSupervisorPhase = "idle";
  private generation = 0;
  private websocketUrl: string | null = null;
  private restartAttempt = 0;
  private lastError: string | null = null;
  private desiredRunning = false;
  private restartTimer: Timer | null = null;
  private startupTimer: Timer | null = null;
  private stableTimer: Timer | null = null;
  private shutdownTimer: Timer | null = null;
  private forceKillTimer: Timer | null = null;
  private shutdownDeadlineTimer: Timer | null = null;
  private stopPromise: Promise<void> | null = null;
  private resolveStop: (() => void) | null = null;

  constructor(options: RuntimeSupervisorOptions) {
    this.spawnProcess = options.spawn;
    this.workerOptions = options.workerOptions;
    this.startupTimeoutMs = boundedDuration(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.stableUptimeMs = boundedDuration(options.stableUptimeMs, DEFAULT_STABLE_UPTIME_MS);
    this.shutdownGraceMs = boundedDuration(options.shutdownGraceMs, DEFAULT_SHUTDOWN_GRACE_MS);
    this.forceKillWaitMs = boundedDuration(options.forceKillWaitMs, DEFAULT_FORCE_KILL_WAIT_MS);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.forceKill = options.forceKill ?? ((pid) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The utility process may have exited between the timeout and signal.
      }
    });
    this.onStateChange = options.onStateChange;
  }

  start(): void {
    if (this.desiredRunning) return;
    this.desiredRunning = true;
    this.clearShutdownTimers();
    this.spawnNext();
  }

  connection(): RuntimeConnection {
    if (this.phase === "ready" && this.websocketUrl) return { websocketUrl: this.websocketUrl };
    if (this.lastError) throw new Error(`The local service is restarting. ${this.lastError}`);
    throw new Error("The local service is starting. Try again in a moment.");
  }

  snapshot(): RuntimeSupervisorSnapshot {
    return {
      phase: this.phase,
      generation: this.generation,
      pid: this.current?.child.pid ?? null,
      websocketUrl: this.websocketUrl,
      restartAttempt: this.restartAttempt,
      restartScheduled: this.restartTimer !== null,
      lastError: this.lastError,
    };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.desiredRunning = false;
    this.clearTimerValue("restartTimer");
    this.clearTimerValue("startupTimer");
    this.clearTimerValue("stableTimer");
    this.websocketUrl = null;

    if (!this.current) {
      this.phase = "stopped";
      this.emitState();
      return Promise.resolve();
    }

    this.phase = "stopping";
    this.current.acceptingReady = false;
    this.emitState();
    this.stopPromise = new Promise<void>((resolve) => { this.resolveStop = resolve; });
    this.post(this.current.child, { type: "runtime.shutdown" });
    const record = this.current;
    const child = record.child;
    this.shutdownTimer = this.setTimer(() => {
      this.shutdownTimer = null;
      child.kill();
      this.forceKillTimer = this.setTimer(() => {
        this.forceKillTimer = null;
        if (this.current !== record) return;
        const pid = child.pid;
        if (pid) this.forceKill(pid);
      }, this.forceKillWaitMs);
    }, this.shutdownGraceMs);
    this.shutdownDeadlineTimer = this.setTimer(() => {
      this.shutdownDeadlineTimer = null;
      if (this.current !== record) return;
      const pid = child.pid;
      if (pid) this.forceKill(pid);
      this.lastError = "The runtime process did not report exit before the shutdown deadline; forced termination was requested.";
      this.settleStopped(record);
    }, this.shutdownGraceMs + this.forceKillWaitMs * 2);
    return this.stopPromise;
  }

  private spawnNext(): void {
    if (!this.desiredRunning || this.current) return;
    this.clearTimerValue("restartTimer");
    const generation = this.generation + 1;
    this.generation = generation;
    this.websocketUrl = null;
    this.phase = this.restartAttempt > 0 ? "restarting" : "starting";

    let child: UtilityProcess;
    try {
      child = this.spawnProcess();
    } catch (error) {
      this.lastError = publicProcessError(error, "The runtime process could not be created.");
      this.scheduleRestart();
      return;
    }

    const record: RuntimeProcessRecord = {
      child,
      generation,
      ready: false,
      acceptingReady: true,
      reportedFailure: null,
    };
    this.current = record;
    child.once("spawn", () => {
      if (this.current !== record) return;
      this.post(child, this.desiredRunning
        ? { type: "runtime.start", options: this.workerOptions }
        : { type: "runtime.shutdown" });
    });
    child.on("message", (message) => this.handleMessage(record, message));
    child.on("error", (type, location) => {
      if (this.current !== record) return;
      this.lastError = `The runtime process encountered ${type}${location ? ` at ${location}` : ""}.`;
      this.emitState();
    });
    child.once("exit", (code) => this.handleExit(record, code));
    this.startupTimer = this.setTimer(() => {
      this.startupTimer = null;
      if (this.current !== record || record.ready) return;
      record.acceptingReady = false;
      this.lastError = "The runtime process did not become ready in time.";
      this.emitState();
      child.kill();
    }, this.startupTimeoutMs);
    this.emitState();
  }

  private handleMessage(record: RuntimeProcessRecord, message: unknown): void {
    if (this.current !== record) return;
    const event = parseRuntimeWorkerEvent(message);
    if (!event) {
      this.lastError = "The runtime process sent an invalid lifecycle message.";
      record.acceptingReady = false;
      this.clearTimerValue("startupTimer");
      record.child.kill();
      this.emitState();
      return;
    }
    if (event.type === "runtime.startup-failed") {
      record.reportedFailure = event.message;
      record.acceptingReady = false;
      this.lastError = event.message;
      this.clearTimerValue("startupTimer");
      this.emitState();
      return;
    }
    if (event.type === "runtime.stopped") {
      record.acceptingReady = false;
      return;
    }
    if (!this.desiredRunning || !record.acceptingReady || record.ready) return;
    record.ready = true;
    this.websocketUrl = event.websocketUrl;
    this.lastError = null;
    this.phase = "ready";
    this.clearTimerValue("startupTimer");
    this.clearTimerValue("stableTimer");
    this.stableTimer = this.setTimer(() => {
      this.stableTimer = null;
      if (this.current !== record || !record.ready || !this.desiredRunning) return;
      this.restartAttempt = 0;
      this.emitState();
    }, this.stableUptimeMs);
    this.emitState();
  }

  private handleExit(record: RuntimeProcessRecord, code: number): void {
    if (this.current !== record) return;
    this.clearTimerValue("startupTimer");
    this.clearTimerValue("stableTimer");

    if (!this.desiredRunning) {
      this.settleStopped(record);
      return;
    }

    this.current = null;
    this.websocketUrl = null;
    this.clearShutdownTimers();
    this.lastError = record.reportedFailure
      ?? this.lastError
      ?? `The runtime process exited unexpectedly (code ${code}).`;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (!this.desiredRunning || this.current || this.restartTimer) return;
    const delay = runtimeRestartDelayMs(this.restartAttempt);
    this.restartAttempt += 1;
    this.phase = "restarting";
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.spawnNext();
    }, delay);
    this.emitState();
  }

  private post(child: UtilityProcess, message: RuntimeWorkerCommand): void {
    try {
      child.postMessage(message);
    } catch (error) {
      this.lastError = publicProcessError(error, "The runtime process could not receive a lifecycle message.");
      child.kill();
      this.emitState();
    }
  }

  private clearShutdownTimers(): void {
    this.clearTimerValue("shutdownTimer");
    this.clearTimerValue("forceKillTimer");
    this.clearTimerValue("shutdownDeadlineTimer");
  }

  private settleStopped(record: RuntimeProcessRecord): void {
    if (this.current !== record || this.desiredRunning) return;
    this.current = null;
    this.websocketUrl = null;
    this.clearShutdownTimers();
    this.phase = "stopped";
    this.emitState();
    this.resolveStop?.();
    this.resolveStop = null;
  }

  private clearTimerValue(key: "restartTimer" | "startupTimer" | "stableTimer" | "shutdownTimer" | "forceKillTimer" | "shutdownDeadlineTimer"): void {
    const timer = this[key];
    if (!timer) return;
    this.clearTimer(timer);
    this[key] = null;
  }

  private emitState(): void {
    this.onStateChange?.(this.snapshot());
  }
}

function boundedDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), 120_000));
}

function publicProcessError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim().replace(/\s+/gu, " ").slice(0, 500);
  return message || fallback;
}
