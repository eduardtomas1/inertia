import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import type { BackendCredentialStatus } from "../shared/backend-credentials";

import type { OpenProjectPathRequest, RuntimeConnection } from "../shared/desktop.js";
import {
  parseRuntimeWorkerEvent,
  type RuntimeCredentialOperation,
  type RuntimeWorkerCommand,
  type RuntimeWorkerOptions,
} from "./runtime-process-protocol.js";
import {
  RuntimeAttachmentBrokerCoordinator,
  type RuntimeAttachmentBroker,
} from "./runtime-attachment-broker.js";

export type { RuntimeAttachmentBroker } from "./runtime-attachment-broker.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_STABLE_UPTIME_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS = 10_000;
const INITIAL_RESTART_DELAY_MS = 500;
const MAX_RESTART_DELAY_MS = 8_000;

type Timer = ReturnType<typeof setTimeout>;

interface RuntimeProcessRecord {
  child: UtilityProcess;
  generation: number;
  ready: boolean;
  acceptingReady: boolean;
  reportedFailure: string | null;
  credentialRequestIds: Set<string>;
  attachmentRequestIds: Set<string>;
  attachmentClaimCounts: Map<string, number>;
  deferredAttachmentReleaseIds: Set<string>;
  deletingAttachmentIds: Set<string>;
  attachmentOperationTails: Map<string, Promise<void>>;
}

interface PendingProjectPath {
  record: RuntimeProcessRecord;
  timer: Timer;
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

interface PendingCredentialRequest {
  record: RuntimeProcessRecord;
  operation: RuntimeCredentialOperation;
  timer: Timer;
  controller: AbortController;
}

export interface RuntimeCredentialBroker {
  resolve(secretReference: string, signal?: AbortSignal): Promise<string | null>;
  status(secretReference: string, signal?: AbortSignal): Promise<BackendCredentialStatus>;
  clear(secretReference: string, signal?: AbortSignal): Promise<boolean>;
  forget(secretReference: string, signal?: AbortSignal): Promise<boolean>;
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
  credentialBroker?: RuntimeCredentialBroker;
  credentialRequestTimeoutMs?: number;
  attachmentBroker?: RuntimeAttachmentBroker;
  attachmentRequestTimeoutMs?: number;
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
  private readonly credentialBroker?: RuntimeCredentialBroker;
  private readonly credentialRequestTimeoutMs: number;
  private readonly attachmentRequests: RuntimeAttachmentBrokerCoordinator<RuntimeProcessRecord>;
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
  private readonly pendingProjectPaths = new Map<string, PendingProjectPath>();
  private readonly pendingCredentialRequests = new Map<string, PendingCredentialRequest>();
  private stopPromise: Promise<boolean> | null = null;
  private resolveStop: ((confirmed: boolean) => void) | null = null;

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
    this.credentialBroker = options.credentialBroker;
    this.credentialRequestTimeoutMs = boundedDuration(
      options.credentialRequestTimeoutMs,
      DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS,
    );
    this.attachmentRequests = new RuntimeAttachmentBrokerCoordinator({
      broker: options.attachmentBroker,
      timeoutMs: boundedDuration(
        options.attachmentRequestTimeoutMs,
        DEFAULT_REQUEST_TIMEOUT_MS,
      ),
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      accepts: (record) => this.acceptsBrokerRequests(record),
      post: (record, result) => this.post(record.child, result),
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

  resolveProjectPath(request: OpenProjectPathRequest): Promise<string> {
    const record = this.current;
    if (this.phase !== "ready" || !record?.ready) {
      return Promise.reject(new Error(this.lastError
        ? `The local service is restarting. ${this.lastError}`
        : "The local service is starting. Try again in a moment."));
    }
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pendingProjectPaths.delete(requestId);
        reject(new Error("The project path request timed out."));
      }, DEFAULT_REQUEST_TIMEOUT_MS);
      this.pendingProjectPaths.set(requestId, { record, timer, resolve, reject });
      this.post(record.child, { type: "runtime.resolve-project-path", requestId, request });
    });
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

  ownsAttachment(attachmentId: string): boolean {
    return (this.current?.attachmentClaimCounts.get(attachmentId) ?? 0) > 0;
  }

  deferAttachmentRelease(attachmentId: string): boolean {
    return this.current
      ? this.attachmentRequests.deferRendererRelease(
          this.current,
          attachmentId,
        )
      : false;
  }

  stop(): Promise<boolean> {
    if (this.stopPromise) return this.stopPromise;
    this.desiredRunning = false;
    this.clearTimerValue("restartTimer");
    this.clearTimerValue("startupTimer");
    this.clearTimerValue("stableTimer");
    this.websocketUrl = null;
    this.rejectProjectPaths(this.current, "The local service is stopping.");
    this.clearCredentialRequests(this.current);

    if (!this.current) {
      this.phase = "stopped";
      this.emitState();
      return Promise.resolve(true);
    }

    this.phase = "stopping";
    this.current.acceptingReady = false;
    this.emitState();
    this.stopPromise = new Promise<boolean>((resolve) => {
      this.resolveStop = resolve;
    });
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
      this.emitState();
      this.resolveStop?.(false);
      this.resolveStop = null;
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
      credentialRequestIds: new Set(),
      attachmentRequestIds: new Set(),
      attachmentClaimCounts: new Map(),
      deferredAttachmentReleaseIds: new Set(),
      deletingAttachmentIds: new Set(),
      attachmentOperationTails: new Map(),
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
    if (event.type === "runtime.credential-request") {
      this.handleCredentialRequest(record, event);
      return;
    }
    if (
      event.type === "runtime.attachment-request"
      || event.type === "runtime.attachment-release-request"
      || event.type === "runtime.attachment-cleanup-request"
      || event.type === "runtime.attachment-relinquish-request"
    ) {
      this.attachmentRequests.handle(record, event);
      return;
    }
    if (event.type === "runtime.project-path-resolved" || event.type === "runtime.project-path-rejected") {
      const pending = this.pendingProjectPaths.get(event.requestId);
      if (!pending || pending.record !== record) return;
      this.pendingProjectPaths.delete(event.requestId);
      this.clearTimer(pending.timer);
      if (event.type === "runtime.project-path-resolved") pending.resolve(event.path);
      else pending.reject(new Error(event.message));
      return;
    }
    if (event.type === "runtime.startup-failed") {
      record.reportedFailure = event.message;
      record.acceptingReady = false;
      this.lastError = event.message;
      this.clearTimerValue("startupTimer");
      this.clearCredentialRequests(record);
      this.attachmentRequests.clear(record);
      this.emitState();
      return;
    }
    if (event.type === "runtime.stopped") {
      record.acceptingReady = false;
      this.clearCredentialRequests(record);
      this.attachmentRequests.clear(record);
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
    this.rejectProjectPaths(record, "The local service stopped before the project path was resolved.");
    this.clearCredentialRequests(record);
    this.attachmentRequests.clear(record);

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

  private rejectProjectPaths(record: RuntimeProcessRecord | null, message: string): void {
    if (!record) return;
    for (const [requestId, pending] of this.pendingProjectPaths) {
      if (pending.record !== record) continue;
      this.pendingProjectPaths.delete(requestId);
      this.clearTimer(pending.timer);
      pending.reject(new Error(message));
    }
  }

  private handleCredentialRequest(
    record: RuntimeProcessRecord,
    event: Extract<
      ReturnType<typeof parseRuntimeWorkerEvent>,
      { type: "runtime.credential-request" }
    >,
  ): void {
    if (!event) return;
    if (!this.acceptsBrokerRequests(record) || !this.credentialBroker) {
      this.post(record.child, {
        type: "runtime.credential-result",
        requestId: event.requestId,
        operation: event.operation,
        ok: false,
        code: "unavailable",
        message: "Secure credential storage is unavailable.",
      });
      return;
    }
    if (record.credentialRequestIds.has(event.requestId)) {
      this.post(record.child, {
        type: "runtime.credential-result",
        requestId: event.requestId,
        operation: event.operation,
        ok: false,
        code: "invalid",
        message: "The credential request identifier was already used.",
      });
      return;
    }
    record.credentialRequestIds.add(event.requestId);
    if (record.credentialRequestIds.size > 512) {
      const oldest = record.credentialRequestIds.values().next().value;
      if (typeof oldest === "string") record.credentialRequestIds.delete(oldest);
    }
    const controller = new AbortController();
    const pending: PendingCredentialRequest = {
      record,
      operation: event.operation,
      controller,
      timer: this.setTimer(() => {
        if (this.pendingCredentialRequests.get(event.requestId) !== pending) return;
        this.pendingCredentialRequests.delete(event.requestId);
        pending.controller.abort();
        if (this.current !== record) return;
        this.post(record.child, {
          type: "runtime.credential-result",
          requestId: event.requestId,
          operation: event.operation,
          ok: false,
          code: "unavailable",
          message: "Secure credential storage did not respond in time.",
        });
      }, this.credentialRequestTimeoutMs),
    };
    this.pendingCredentialRequests.set(event.requestId, pending);
    const operation = Promise.resolve().then<string | null | boolean | BackendCredentialStatus>(() => event.operation === "resolve"
      ? this.credentialBroker!.resolve(event.secretReference, controller.signal)
      : event.operation === "status"
        ? this.credentialBroker!.status(event.secretReference, controller.signal)
        : event.operation === "clear"
          ? this.credentialBroker!.clear(event.secretReference, controller.signal)
          : this.credentialBroker!.forget(event.secretReference, controller.signal));
    void operation.then(
      (value) => {
        if (this.pendingCredentialRequests.get(event.requestId) !== pending) return;
        this.pendingCredentialRequests.delete(event.requestId);
        this.clearTimer(pending.timer);
        if (!this.acceptsBrokerRequests(record)) return;
        if (event.operation === "resolve") {
          if (typeof value !== "string") {
            this.post(record.child, {
              type: "runtime.credential-result",
              requestId: event.requestId,
              operation: "resolve",
              ok: false,
              code: "not-found",
              message: "The backend credential is unavailable.",
            });
            return;
          }
          this.post(record.child, {
            type: "runtime.credential-result",
            requestId: event.requestId,
            operation: "resolve",
            ok: true,
            secret: value,
          });
          return;
        }
        if (event.operation === "status") {
          const status = typeof value === "object" && value !== null
            ? value as BackendCredentialStatus
            : { hasSecret: false, credentialGeneration: null };
          this.post(record.child, {
              type: "runtime.credential-result",
              requestId: event.requestId,
              operation: "status",
              ok: true,
              hasSecret: status.hasSecret,
              credentialGeneration: status.credentialGeneration,
            });
          return;
        }
        this.post(record.child, {
              type: "runtime.credential-result",
              requestId: event.requestId,
              operation: event.operation,
              ok: true,
              removed: value === true,
            });
      },
      () => {
        if (this.pendingCredentialRequests.get(event.requestId) !== pending) return;
        this.pendingCredentialRequests.delete(event.requestId);
        this.clearTimer(pending.timer);
        if (!this.acceptsBrokerRequests(record)) return;
        this.post(record.child, {
          type: "runtime.credential-result",
          requestId: event.requestId,
          operation: event.operation,
          ok: false,
          code: "unavailable",
          message: "Secure credential storage is unavailable.",
        });
      },
    );
  }

  private acceptsBrokerRequests(record: RuntimeProcessRecord): boolean {
    return this.current === record
      && this.desiredRunning
      && record.acceptingReady
      && (
        this.phase === "starting"
        || this.phase === "restarting"
        || this.phase === "ready"
      );
  }

  private clearCredentialRequests(record: RuntimeProcessRecord | null): void {
    if (!record) return;
    for (const [requestId, pending] of this.pendingCredentialRequests) {
      if (pending.record !== record) continue;
      this.pendingCredentialRequests.delete(requestId);
      this.clearTimer(pending.timer);
      pending.controller.abort();
    }
  }

  private settleStopped(record: RuntimeProcessRecord): void {
    if (this.current !== record || this.desiredRunning) return;
    this.current = null;
    this.websocketUrl = null;
    this.clearShutdownTimers();
    this.phase = "stopped";
    this.emitState();
    this.resolveStop?.(true);
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
