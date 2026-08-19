import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import type { BackendCredentialStatus } from "../shared/backend-credentials";
import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
} from "../shared/private-connect/runtime-contract";
import type {
  OpenProjectPathRequest,
  RuntimeConnection,
} from "../shared/desktop.js";
import {
  parseRuntimeWorkerEvent,
  validSystemBootId,
  type RuntimeDatabaseRecoveryOperation,
  type RuntimeDatabaseRecoverySummary,
  type RuntimeDatabaseStartupRecoveryReport,
  type RuntimePrivateConnectForgetScope,
  type RuntimePrivateConnectPromptPreparation,
  type RuntimeUpdatePreparationResult,
  type RuntimeWorkerCommand,
} from "../node/runtime-process-protocol.js";
import { RuntimeAttachmentBrokerCoordinator } from "./runtime-attachment-broker.js";
import { forceKillRuntimeProcessTree } from "./runtime-process-tree.js";
import { RuntimePrivateConnectPromptCoordinator } from "./runtime-private-connect-prompt-coordinator.js";
import { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import { persistRuntimeGenerationCleanup } from "./runtime-generation-cleanup.js";
import { readSystemBootId } from "./system-boot-id.js";
import {
  boundedDuration,
  publicProcessError,
  runtimeRestartDelayMs,
  runtimeSupervisorDefaults,
  unconfirmedRuntimeCleanupMessage,
} from "./runtime-supervisor-values.js";
import { runtimeConnection } from "./runtime-supervisor-connection.js";
import { RuntimeSupervisorRecycle } from "./runtime-supervisor-recycle.js";
import { RuntimeSecureFileCoordinator } from "./runtime-secure-file-coordinator.js";
import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { RuntimeUpdatePreparationCoordinator } from "./runtime-update-preparation-coordinator.js";
import { RuntimeDatabaseRecoveryCoordinator } from "./runtime-database-recovery-coordinator.js";
import { recoverRuntimeOwnedProcesses } from "./runtime-owned-process-recovery.js";
import { RuntimeSupervisorStartupRecovery } from "./runtime-supervisor-startup-recovery.js";
import { RuntimeOwnedProcessJournal } from "../node/runtime-owned-processes.js";
import type {
  PendingCredentialRequest,
  PendingPrivateConnectRuntimeRequest,
  PendingProjectPath,
  RuntimeCredentialBroker,
  RuntimeProcessRecord,
  RuntimeSupervisorOptions,
  RuntimeSupervisorPhase,
  RuntimeSupervisorSnapshot,
  RuntimeSupervisorTimer,
} from "./runtime-supervisor-types.js";
export type { RuntimeAttachmentBroker } from "./runtime-attachment-broker.js";
export type { RuntimeCredentialBroker, RuntimeSecureFileBroker,
  RuntimeSupervisorOptions, RuntimeSupervisorPhase,
  RuntimeSupervisorSnapshot } from "./runtime-supervisor-types.js";
export { runtimeRestartDelayMs } from "./runtime-supervisor-values.js";
type PrivateConnectPromptRequest = Extract<PrivateConnectRuntimeRequest,
  { type: "prompt.send" }>;
export class RuntimeSupervisor {
  private readonly spawnProcess: RuntimeSupervisorOptions["spawn"];
  private readonly workerOptions: RuntimeSupervisorOptions["workerOptions"];
  private readonly systemBootId: string;
  private readonly startupTimeoutMs: number;
  private readonly stableUptimeMs: number;
  private readonly shutdownGraceMs: number;
  private readonly forceKillWaitMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly forceKill: NonNullable<RuntimeSupervisorOptions["forceKill"]>;
  private readonly recoverOwnedProcesses:
    NonNullable<RuntimeSupervisorOptions["recoverOwnedProcesses"]>;
  private readonly credentialBroker?: RuntimeCredentialBroker;
  private readonly credentialRequestTimeoutMs: number;
  private readonly attachmentRequests: RuntimeAttachmentBrokerCoordinator<RuntimeProcessRecord>;
  private readonly onStateChange?: RuntimeSupervisorOptions["onStateChange"];
  private current: RuntimeProcessRecord | null = null;
  private readonly quarantined = new Set<RuntimeProcessRecord>();
  private phase: RuntimeSupervisorPhase = "idle";
  private generation = 0;
  private websocketUrl: string | null = null;
  private restartAttempt = 0;
  private lastError: string | null = null;
  private databaseRecoveryReport: RuntimeDatabaseStartupRecoveryReport | null = null;
  private databaseRecoveryNoticePending = false;
  private desiredRunning = false;
  private restartBlocked = false;
  private unconfirmedRestarts = 0;
  private readonly ownerNonce = randomUUID();
  private readonly cleanupReceipts: RuntimeCleanupReceiptJournal;
  private readonly runtimeGenerationLeases: RuntimeGenerationLeaseJournal;
  private readonly runtimeOwnedProcesses: RuntimeOwnedProcessJournal;
  private restartTimer: RuntimeSupervisorTimer | null = null;
  private startupTimer: RuntimeSupervisorTimer | null = null;
  private stableTimer: RuntimeSupervisorTimer | null = null;
  private shutdownTimer: RuntimeSupervisorTimer | null = null;
  private shutdownDeadlineTimer: RuntimeSupervisorTimer | null = null;
  private readonly startupRecovery: RuntimeSupervisorStartupRecovery;
  private readonly pendingProjectPaths = new Map<string, PendingProjectPath>();
  private readonly pendingPrivateConnectRuntimeRequests = new Map<string, PendingPrivateConnectRuntimeRequest>();
  private readonly databaseRecoveryRequests: RuntimeDatabaseRecoveryCoordinator;
  private readonly updatePreparation: RuntimeUpdatePreparationCoordinator;
  private readonly privateConnectPrompts: RuntimePrivateConnectPromptCoordinator<
    RuntimeProcessRecord>;
  private readonly pendingCredentialRequests = new Map<string, PendingCredentialRequest>();
  private readonly secureFiles: RuntimeSecureFileCoordinator;
  private stopPromise: Promise<boolean> | null = null;
  private resolveStop: ((confirmed: boolean) => void) | null = null;
  private readonly testRecycle = new RuntimeSupervisorRecycle();
  constructor(options: RuntimeSupervisorOptions) {
    this.spawnProcess = options.spawn;
    this.workerOptions = options.workerOptions;
    const systemBootId = options.systemBootId ?? readSystemBootId()
      ?? "unavailable";
    if (!validSystemBootId(systemBootId)) {
      throw new Error("The operating system boot identity is unavailable.");
    }
    this.systemBootId = systemBootId;
    this.cleanupReceipts = new RuntimeCleanupReceiptJournal(
      options.workerOptions.dataDirectory,
    );
    this.runtimeGenerationLeases = new RuntimeGenerationLeaseJournal(
      options.workerOptions.dataDirectory,
    );
    this.runtimeOwnedProcesses = new RuntimeOwnedProcessJournal(options.workerOptions.dataDirectory);
    this.startupTimeoutMs = boundedDuration(options.startupTimeoutMs, runtimeSupervisorDefaults.startupTimeoutMs);
    this.stableUptimeMs = boundedDuration(options.stableUptimeMs, runtimeSupervisorDefaults.stableUptimeMs);
    this.shutdownGraceMs = boundedDuration(options.shutdownGraceMs, runtimeSupervisorDefaults.shutdownGraceMs);
    this.forceKillWaitMs = boundedDuration(options.forceKillWaitMs, runtimeSupervisorDefaults.forceKillWaitMs);
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.forceKill = options.forceKill
      ?? ((pid, deadlineAt) =>
        forceKillRuntimeProcessTree(pid, { deadlineAt }));
    this.recoverOwnedProcesses = options.recoverOwnedProcesses
      ?? ((runtimeGenerationId, systemBootId, deadlineAt) =>
        recoverRuntimeOwnedProcesses(options.workerOptions.dataDirectory,
          runtimeGenerationId, systemBootId, { deadlineAt }));
    this.startupRecovery = new RuntimeSupervisorStartupRecovery({
      dataDirectory: options.workerOptions.dataDirectory, systemBootId,
      forceKillWaitMs: this.forceKillWaitMs, leases: this.runtimeGenerationLeases,
      receipts: this.cleanupReceipts,
    });
    this.privateConnectPrompts = new RuntimePrivateConnectPromptCoordinator({
      timeoutMs: runtimeSupervisorDefaults.requestTimeoutMs,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      post: (record, command) => this.post(record.child, command),
    });
    this.credentialBroker = options.credentialBroker;
    this.secureFiles = new RuntimeSecureFileCoordinator({
      broker: options.secureFileBroker,
      conversationAttachmentStoreRunner:
        options.conversationAttachmentStoreRunner,
      conversationAttachmentStoreAuthority:
        options.conversationAttachmentStoreAuthority,
      accepts: (record) => this.acceptsBrokerRequests(record),
      post: (record, command) => this.post(record.child, command),
    });
    this.credentialRequestTimeoutMs = boundedDuration(
      options.credentialRequestTimeoutMs,
      runtimeSupervisorDefaults.credentialRequestTimeoutMs,
    );
    this.attachmentRequests = new RuntimeAttachmentBrokerCoordinator({
      broker: options.attachmentBroker,
      timeoutMs: boundedDuration(
        options.attachmentRequestTimeoutMs,
        runtimeSupervisorDefaults.requestTimeoutMs,
      ),
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      accepts: (record) => this.acceptsBrokerRequests(record),
      post: (record, result) => this.post(record.child, result),
    });
    this.databaseRecoveryRequests = new RuntimeDatabaseRecoveryCoordinator({
      requestTimeoutMs: boundedDuration(
        options.databaseRecoveryRequestTimeoutMs,
        runtimeSupervisorDefaults.databaseRecoveryTimeoutMs,
      ),
      cancelTimeoutMs: boundedDuration(
        options.databaseRecoveryCancelTimeoutMs,
        runtimeSupervisorDefaults.databaseRecoveryCancelTimeoutMs,
      ),
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      post: (record, command) => this.post(record.child, command),
      cancellationUnconfirmed: (record) => {
        this.lastError = "The runtime did not confirm database recovery cancellation.";
        this.forceTerminate(record.child);
        this.emitState();
      },
    });
    this.updatePreparation = new RuntimeUpdatePreparationCoordinator({
      timeoutMs: runtimeSupervisorDefaults.requestTimeoutMs,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      current: () => this.current,
      post: (record, command) => this.post(record.child, command),
      forceTerminate: (record) => this.forceTerminate(record.child),
    });
    this.onStateChange = options.onStateChange;
  }
  start(): void {
    if (this.desiredRunning || this.restartBlocked) return;
    this.desiredRunning = true;
    this.clearShutdownTimers();
    const priorRecovery = this.startupRecovery.begin(() => {
      if (this.desiredRunning) this.spawnNext();
    });
    if (!priorRecovery) {
      this.spawnNext();
      return;
    }
    this.phase = "starting";
    this.emitState();
  }
  connection(): RuntimeConnection {
    const result = runtimeConnection({
      phase: this.phase,
      generation: this.generation,
      websocketUrl: this.websocketUrl,
      databaseRecoveryReport: this.databaseRecoveryReport,
      databaseRecoveryNoticePending: this.databaseRecoveryNoticePending,
      lastError: this.lastError,
    });
    if (result.consumedRecoveryNotice) {
      this.databaseRecoveryNoticePending = false;
    }
    return result.connection;
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
      }, runtimeSupervisorDefaults.requestTimeoutMs);
      this.pendingProjectPaths.set(requestId, { record, timer, resolve, reject });
      this.post(record.child, { type: "runtime.resolve-project-path", requestId, request });
    });
  }
  prepareForUpdate(): Promise<RuntimeUpdatePreparationResult> {
    const record = this.current;
    if (this.phase !== "ready" || !record?.ready) {
      return Promise.reject(new Error("The local service is not ready for update preparation."));
    }
    return this.updatePreparation.prepare(record);
  }
  /**
   * Reopens admission for the supervisor-owned preparation token. This is
   * idempotent once no gate is held and never releases a different generation.
   */
  releaseUpdatePreparation(): Promise<boolean> {
    return this.updatePreparation.release();
  }
  databaseRecovery(
    operation: RuntimeDatabaseRecoveryOperation,
    path: string,
    targetDirectory?: string,
  ): Promise<RuntimeDatabaseRecoverySummary | null> {
    if (operation === "import" && !targetDirectory) {
      return Promise.reject(new Error(
        "The recovery import needs an explicitly authorized destination folder.",
      ));
    }
    const record = this.current;
    if (this.phase !== "ready" || !record?.ready) {
      return Promise.reject(new Error(this.lastError
        ? `The local service is restarting. ${this.lastError}`
        : "The local service is starting. Try again in a moment."));
    }
    return this.databaseRecoveryRequests.request(
      record,
      operation,
      path,
      targetDirectory,
    );
  }
  privateConnectRequest(
    subject: PrivateConnectRuntimeAuthorization,
    request: Exclude<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
  ): Promise<PrivateConnectRuntimeResponse> {
    const record = this.current;
    if (this.phase !== "ready" || !record?.ready) {
      return Promise.reject(new Error(
        this.lastError
          ? `The local service is restarting. ${this.lastError}`
          : "The local service is starting. Try again in a moment.",
      ));
    }
    if (this.pendingPrivateConnectRuntimeRequests.has(request.requestId)) {
      return Promise.reject(new Error(
        "The Private Connect request identifier is already active.",
      ));
    }
    return new Promise<PrivateConnectRuntimeResponse>((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pendingPrivateConnectRuntimeRequests.delete(request.requestId);
        reject(new Error("The Private Connect request timed out."));
      }, runtimeSupervisorDefaults.requestTimeoutMs);
      this.pendingPrivateConnectRuntimeRequests.set(request.requestId, {
        record,
        timer,
        resolve,
        reject,
      });
      this.post(record.child, {
        type: "runtime.private-connect-request",
        requestId: request.requestId,
        subject,
        request,
      });
    });
  }
  preparePrivateConnectPrompt(
    subject: PrivateConnectRuntimeAuthorization,
    request: PrivateConnectPromptRequest,
  ): Promise<RuntimePrivateConnectPromptPreparation | PrivateConnectRuntimeResponse> {
    const record = this.privateConnectPromptRecord();
    return record instanceof Error
      ? Promise.reject(record)
      : this.privateConnectPrompts.prepare(record, subject, request);
  }
  forgetPrivateConnectTranscripts(scope: RuntimePrivateConnectForgetScope): void {
    const record = this.current;
    if (this.phase !== "ready" || !record?.ready) return;
    this.post(record.child, { type: "runtime.private-connect-forget", scope });
  }
  commitPrivateConnectPrompt(
    subject: PrivateConnectRuntimeAuthorization,
    request: PrivateConnectPromptRequest,
    preparationId: string,
    onPosted?: () => void,
  ): Promise<PrivateConnectRuntimeResponse> {
    const record = this.privateConnectPromptRecord();
    return record instanceof Error
      ? Promise.reject(record)
      : this.privateConnectPrompts.commit(
          record,
          subject,
          request,
          preparationId,
          onPosted,
        );
  }
  private privateConnectPromptRecord(): RuntimeProcessRecord | Error {
    const record = this.current;
    if (this.phase !== "ready" || !record?.ready) {
      return new Error(
        this.lastError
          ? `The local service is restarting. ${this.lastError}`
          : "The local service is starting. Try again in a moment.",
      );
    }
    return record;
  }
  snapshot(): RuntimeSupervisorSnapshot {
    return {
      phase: this.phase, generation: this.generation,
      pid: this.current?.child.pid ?? null, websocketUrl: this.websocketUrl,
      restartAttempt: this.restartAttempt,
      restartScheduled: this.restartTimer !== null, lastError: this.lastError,
      databaseRecovery: this.databaseRecoveryReport,
    };
  }
  ownsAttachment(attachmentId: string): boolean {
    const records = [this.current, ...this.quarantined];
    return this.attachmentRequests.owns(records, attachmentId);
  }
  deferAttachmentRelease(attachmentId: string): boolean {
    const records = [this.current, ...this.quarantined];
    return this.attachmentRequests.deferRendererReleaseForAny(records,
      attachmentId);
  }
  testOnlyRecycle(): Promise<boolean> {
    const active = this.testRecycle.activePromise();
    if (active) return active;
    const record = this.current;
    if (
      !record?.ready
      || this.phase !== "ready"
      || !this.desiredRunning
      || this.stopPromise
    ) return Promise.reject(new Error("The runtime is not ready to recycle."));
    const recycle = this.testRecycle.begin(record);
    record.acceptingReady = false;
    this.phase = "restarting";
    this.websocketUrl = null;
    this.rejectProjectPaths(record, "The local service is recycling.");
    this.databaseRecoveryRequests.reject(record, "The local service is recycling.");
    this.rejectPrivateConnectRuntimeRequests(record, "The local service is recycling.");
    this.clearCredentialRequests(record);
    this.secureFiles.clear(record);
    this.emitState();
    if (!this.beginRuntimeShutdown(record, (message) => {
      this.rejectTestRecycle(record, message, !record.cleanupConfirmed);
    })) {
      this.rejectTestRecycle(
        record,
        "The runtime did not accept the clean recycle request.",
        true,
      );
    }
    return recycle.promise;
  }
  stop(): Promise<boolean> {
    this.testRecycle.cancelForStop();
    if (this.stopPromise) return this.stopPromise;
    this.desiredRunning = false;
    this.clearTimerValue("restartTimer");
    this.clearTimerValue("startupTimer");
    this.clearTimerValue("stableTimer");
    this.websocketUrl = null;
    this.databaseRecoveryReport = null;
    this.updatePreparation.clear(
      this.current,
      "The local service is stopping.",
      true,
    );
    this.rejectProjectPaths(this.current, "The local service is stopping.");
    this.databaseRecoveryRequests.reject(
      this.current,
      "The local service is stopping.",
    );
    this.rejectPrivateConnectRuntimeRequests(this.current, "The local service is stopping.");
    this.clearCredentialRequests(this.current);
    this.secureFiles.clear(this.current);
    const secureFilesStopped = this.secureFiles.shutdown();
    if (!this.current) {
      this.phase = this.startupRecovery.activePromise() ? "stopping" : "stopped";
      if (this.quarantined.size > 0) {
        this.restartBlocked = true;
        this.lastError = unconfirmedRuntimeCleanupMessage(
          this.systemBootId,
          "A prior runtime generation still has unconfirmed process cleanup.",
        );
      }
      this.emitState();
      const startupRecovery = this.startupRecovery.activePromise()
        ?? Promise.resolve(true);
      this.stopPromise = Promise.all([secureFilesStopped, startupRecovery])
        .then(([confirmed, recovered]) => {
          this.phase = "stopped";
          this.emitState();
          return confirmed && recovered && this.quarantined.size === 0;
        });
      return this.stopPromise;
    }
    this.phase = "stopping";
    this.current.acceptingReady = false;
    this.emitState();
    const runtimeStopped = new Promise<boolean>((resolve) => {
      this.resolveStop = resolve;
    });
    this.stopPromise = Promise.all([
      runtimeStopped,
      secureFilesStopped,
    ]).then(([runtimeConfirmed, secureFilesConfirmed]) => (
      runtimeConfirmed
      && secureFilesConfirmed
      && this.quarantined.size === 0
    ));
    this.beginRuntimeShutdown(this.current, () => {
      this.resolveStop?.(false);
      this.resolveStop = null;
    });
    return this.stopPromise;
  }
  private beginRuntimeShutdown(
    record: RuntimeProcessRecord,
    onDeadline: (message: string) => void,
  ): boolean {
    this.clearShutdownTimers();
    const child = record.child;
    const shutdownDeadlineMs =
      this.shutdownGraceMs + this.forceKillWaitMs * 2;
    record.shutdownDeadlineAt = Date.now() + shutdownDeadlineMs;
    this.shutdownTimer = this.setTimer(() => {
      this.shutdownTimer = null;
      this.forceTerminate(child);
    }, this.shutdownGraceMs);
    this.shutdownDeadlineTimer = this.setTimer(() => {
      this.shutdownDeadlineTimer = null;
      if (this.current !== record) return;
      this.lastError = record.processTreeTerminationConfirmed
        ? "The runtime process did not report exit before the shutdown deadline; forced termination was requested."
        : "The runtime process tree could not be confirmed stopped.";
      this.emitState();
      onDeadline(this.lastError);
    }, shutdownDeadlineMs);
    return this.post(child, { type: "runtime.shutdown" });
  }
  private rejectTestRecycle(
    record: RuntimeProcessRecord,
    message: string,
    cleanupRejected: boolean,
  ): void {
    if (!this.testRecycle.reject(message, record, cleanupRejected)) return;
    if (cleanupRejected) {
      record.cleanupConfirmed = false;
      this.quarantined.add(record);
    }
    this.desiredRunning = false;
    this.restartBlocked = true;
    this.clearTimerValue("restartTimer");
    this.lastError = message;
    this.emitState();
  }
  private spawnNext(): void {
    if (!this.desiredRunning || this.current) return;
    this.clearTimerValue("restartTimer");
    const generation = this.generation + 1;
    this.generation = generation;
    const runtimeGenerationId = `${this.ownerNonce}:${generation}`;
    this.websocketUrl = null;
    this.phase = this.restartAttempt > 0 ? "restarting" : "starting";
    this.runtimeGenerationLeases.refresh();
    if (!this.runtimeOwnedProcesses.startSession(runtimeGenerationId, this.systemBootId)
      || !this.runtimeGenerationLeases.publish(
      runtimeGenerationId,
      this.systemBootId,
    )) {
      this.runtimeOwnedProcesses.finishSession(runtimeGenerationId);
      this.restartBlocked = true;
      this.desiredRunning = false;
      this.phase = "stopped";
      this.lastError = "The runtime generation ownership lease could not be persisted.";
      this.emitState();
      return;
    }

    let child: UtilityProcess;
    try {
      child = this.spawnProcess();
    } catch (error) {
      if (!this.runtimeOwnedProcesses.finishSession(runtimeGenerationId)
        || !this.runtimeGenerationLeases.consume(runtimeGenerationId)) {
        this.restartBlocked = true;
        this.desiredRunning = false;
        this.phase = "stopped";
        this.lastError = "The unstarted runtime generation lease could not be retired.";
        this.emitState();
        return;
      }
      this.lastError = publicProcessError(error, "The runtime process could not be created.");
      this.scheduleRestart();
      return;
    }

    const record: RuntimeProcessRecord = {
      child,
      generation,
      runtimeGenerationId,
      cleanupReceiptIds: new Set(this.cleanupReceipts.pending()),
      ready: false,
      acceptingReady: true,
      cleanupConfirmed: false,
      generationCleanupConfirmed: false,
      processTreeTerminationConfirmed: true,
      processTreeTermination: null,
      processTreeTerminationSettled: false,
      shutdownDeadlineAt: null,
      reportedFailure: null,
      credentialRequestIds: new Set(),
      secureFileRequestIds: new Set(),
      attachmentRequestIds: new Set(),
      attachmentClaimCounts: new Map(),
      deferredAttachmentReleaseIds: new Set(),
      deletingAttachmentIds: new Set(),
      attachmentOperationTails: new Map(),
    };
    this.current = record;
    child.once("spawn", () => {
      if (this.current !== record) return;
      if (!this.desiredRunning) {
        this.post(child, { type: "runtime.shutdown" });
        return;
      }
      const confirmedTerminatedRuntimeGenerationIds = [...record.cleanupReceiptIds];
      this.post(child, {
        type: "runtime.start",
        options: {
          ...this.workerOptions,
          runtimeGenerationId: record.runtimeGenerationId,
          systemBootId: this.systemBootId,
          ...(confirmedTerminatedRuntimeGenerationIds.length > 0
            ? { confirmedTerminatedRuntimeGenerationIds }
            : {}),
          ...(this.quarantined.size > 0
            ? { priorRuntimeCleanupUnconfirmed: true }
            : {}),
        },
      });
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
      this.rejectTestRecycle(record, this.lastError, true);
      this.emitState();
      this.forceTerminate(child);
    }, this.startupTimeoutMs);
    this.emitState();
  }

  private handleMessage(record: RuntimeProcessRecord, message: unknown): void {
    if (this.current !== record) return;
    const event = parseRuntimeWorkerEvent(message);
    if (!event) {
      this.lastError = "The runtime process sent an invalid lifecycle message.";
      this.rejectTestRecycle(record, this.lastError, true);
      record.acceptingReady = false;
      this.clearTimerValue("startupTimer");
      this.forceTerminate(record.child);
      this.emitState();
      return;
    }
    if (event.type === "runtime.credential-request") {
      this.handleCredentialRequest(record, event);
      return;
    }
    if (event.type === "runtime.secure-file-request") {
      this.secureFiles.handle(record, event);
      return;
    }
    if (
      event.type === "runtime.conversation-attachment-store-request"
      || event.type === "runtime.conversation-attachment-store-cancel"
    ) {
      this.secureFiles.handle(record, event);
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
    if (
      event.type === "runtime.prepare-update-result"
      || event.type === "runtime.release-update-preparation-result"
    ) {
      this.updatePreparation.handle(record, event);
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
    if (event.type === "runtime.private-connect-response") {
      const pending = this.pendingPrivateConnectRuntimeRequests.get(event.requestId);
      if (!pending || pending.record !== record) return;
      this.pendingPrivateConnectRuntimeRequests.delete(event.requestId);
      this.clearTimer(pending.timer);
      pending.resolve(event.response);
      return;
    }
    if (event.type === "runtime.database-recovery-result") {
      this.databaseRecoveryRequests.handle(record, event);
      return;
    }
    if (event.type === "runtime.private-connect-prompt-result") {
      this.privateConnectPrompts.handle(record, event);
      return;
    }
    if (event.type === "runtime.startup-failed") {
      record.reportedFailure = event.message;
      record.acceptingReady = false;
      this.lastError = event.message;
      this.rejectTestRecycle(record, event.message, true);
      this.clearTimerValue("startupTimer");
      // The worker normally exits after reporting startup failure, but its
      // partial cleanup can itself stall. Preserve a bounded grace window so
      // one wedged generation cannot leave the supervisor starting forever.
      this.startupTimer = this.setTimer(() => {
        this.startupTimer = null;
        if (this.current !== record || record.ready) return;
        this.forceTerminate(record.child);
      }, this.shutdownGraceMs);
      this.clearCredentialRequests(record);
      this.secureFiles.clear(record);
      this.emitState();
      return;
    }
    if (event.type === "runtime.shutdown-unconfirmed") {
      record.acceptingReady = false;
      this.lastError = "The runtime could not confirm complete process cleanup.";
      this.rejectTestRecycle(record, this.lastError, true);
      this.clearTimerValue("startupTimer");
      this.clearCredentialRequests(record);
      this.secureFiles.clear(record);
      this.forceTerminate(record.child);
      this.emitState();
      return;
    }
    if (event.type === "runtime.stopped") {
      if (!this.testRecycle.cleanupAllowed(record)) return;
      record.acceptingReady = false;
      record.cleanupConfirmed = true;
      if (!record.processTreeTermination) {
        record.processTreeTerminationConfirmed = true;
        record.processTreeTerminationSettled = true;
      }
      this.clearCredentialRequests(record);
      this.secureFiles.clear(record);
      return;
    }
    if (event.type === "runtime.cleanup-receipt-consumed") {
      if (
        event.currentRuntimeGenerationId !== record.runtimeGenerationId
        || !record.cleanupReceiptIds.has(event.receiptRuntimeGenerationId)
        || !this.cleanupReceipts.has(event.receiptRuntimeGenerationId)
      ) return;
      if (!this.cleanupReceipts.consume(event.receiptRuntimeGenerationId)) {
        record.acceptingReady = false;
        this.lastError = "The runtime cleanup receipt could not be consumed safely.";
        this.forceTerminate(record.child);
        this.emitState();
        return;
      }
      record.cleanupReceiptIds.delete(event.receiptRuntimeGenerationId);
      return;
    }
    if (!this.desiredRunning || !record.acceptingReady || record.ready) return;
    if (record.cleanupReceiptIds.size > 0) {
      record.acceptingReady = false;
      this.lastError = "The runtime did not consume every cleanup receipt before startup.";
      this.forceTerminate(record.child);
      this.emitState();
      return;
    }
    record.ready = true;
    this.websocketUrl = event.websocketUrl;
    this.databaseRecoveryReport = event.databaseRecovery ?? null;
    this.databaseRecoveryNoticePending =
      event.databaseRecovery?.outcome === "restored"
      || event.databaseRecovery?.outcome === "created-empty";
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
    this.testRecycle.succeed(record);
    this.emitState();
  }

  private handleExit(record: RuntimeProcessRecord, code: number): void {
    if (this.current !== record) return;
    const exitedBeforeCleanRecycleReadiness = this.testRecycle.owns(record)
      && (!record.cleanupConfirmed || !record.ready);
    record.acceptingReady = false;
    record.ready = false;
    this.websocketUrl = null;
    this.databaseRecoveryReport = null;
    this.databaseRecoveryNoticePending = false;
    this.updatePreparation.clear(
      record,
      "The local service stopped during update preparation.",
      false,
    );
    this.phase = this.desiredRunning ? "restarting" : "stopping";
    this.emitState();
    if (exitedBeforeCleanRecycleReadiness) {
      this.rejectTestRecycle(record, "The recycled runtime exited before clean readiness was confirmed.", !record.cleanupConfirmed);
    }
    this.clearTimerValue("startupTimer");
    this.clearTimerValue("stableTimer");
    this.rejectProjectPaths(record, "The local service stopped before the project path was resolved.");
    this.databaseRecoveryRequests.reject(
      record,
      "The local service stopped before the database recovery request completed.",
    );
    this.rejectPrivateConnectRuntimeRequests(record, "The local service stopped before the Private Connect request completed.");
    this.clearCredentialRequests(record);
    this.secureFiles.clear(record);
    if (!this.secureFiles.hasConversationAttachmentOperations(record)) {
      this.handleDrainedExit(record, code, true);
      return;
    }
    void this.secureFiles.drain(record, true).then(
      (confirmed) => this.handleDrainedExit(record, code, confirmed),
      () => this.handleDrainedExit(record, code, false),
    );
  }

  private handleDrainedExit(record: RuntimeProcessRecord, code: number, secureFileCleanupConfirmed: boolean): void {
    if (this.current !== record) return;
    if (!secureFileCleanupConfirmed) {
      record.cleanupConfirmed = false;
      this.current = null;
      this.clearShutdownTimers();
      this.quarantined.add(record);
      this.restartBlocked = true;
      this.desiredRunning = false;
      this.phase = "stopped";
      this.lastError = "Conversation attachment storage shutdown could not be confirmed.";
      this.rejectTestRecycle(record, this.lastError, true);
      this.resolveStop?.(false);
      this.resolveStop = null;
      this.emitState();
      return;
    }
    if (!record.cleanupConfirmed && !record.processTreeTermination) {
      this.phase = this.desiredRunning ? "restarting" : "stopping";
      this.emitState();
      const deadlineAt = Date.now() + this.forceKillWaitMs * 2;
      const finishRecovery = (confirmed: boolean): void => {
        if (this.current !== record) return;
        if (confirmed) {
          record.cleanupConfirmed = true;
          record.processTreeTerminationConfirmed = true;
          record.processTreeTerminationSettled = true;
          this.handleDrainedExit(record, code, true);
          return;
        }
        this.current = null;
        this.clearShutdownTimers();
        this.quarantined.add(record);
        this.lastError = unconfirmedRuntimeCleanupMessage(this.systemBootId,
          "The runtime exited before complete process-tree cleanup was confirmed.");
        if (!this.desiredRunning) {
          this.phase = "stopped";
          this.restartBlocked = true;
          this.resolveStop?.(false);
          this.resolveStop = null;
        } else if (this.unconfirmedRestarts
          >= runtimeSupervisorDefaults.maxUnconfirmedRestarts) {
          this.phase = "stopped";
          this.restartBlocked = true;
          this.desiredRunning = false;
        } else {
          this.unconfirmedRestarts += 1;
          this.scheduleRestart();
        }
        this.emitState();
      };
      const recovery = this.recoverOwnedProcesses(record.runtimeGenerationId,
        this.systemBootId, deadlineAt);
      if (typeof recovery === "boolean") finishRecovery(recovery);
      else if (recovery) void recovery.catch(() => false).then(finishRecovery);
      else finishRecovery(false);
      return;
    }
    if (!this.desiredRunning) {
      this.settleStopped(record);
      return;
    }

    const continueAfterTermination = (confirmed: boolean): void => {
      if (this.current !== record) return;
      if (!this.desiredRunning) {
        this.settleStopped(record);
        return;
      }
      if (confirmed && record.cleanupConfirmed
        && !this.completeGenerationCleanup(record)) return;
      this.current = null;
      this.clearShutdownTimers();
      if (!confirmed) {
        this.rejectTestRecycle(record, "The recycled runtime process tree could not be confirmed stopped.", false);
        this.quarantined.add(record);
        this.restartBlocked = true;
        this.desiredRunning = false;
        this.phase = "stopped";
        this.lastError = "The runtime process tree could not be confirmed stopped.";
        this.emitState();
        return;
      }
      if (!record.cleanupConfirmed) {
        this.quarantined.add(record);
        this.lastError = unconfirmedRuntimeCleanupMessage(this.systemBootId,
          "The runtime process tree was stopped, but prior detached work could not be confirmed cleaned up.");
        if (this.unconfirmedRestarts >= runtimeSupervisorDefaults.maxUnconfirmedRestarts) {
          this.restartBlocked = true;
          this.desiredRunning = false;
          this.phase = "stopped";
          this.emitState();
          return;
        }
        this.unconfirmedRestarts += 1;
        this.scheduleRestart();
        return;
      }
      this.attachmentRequests.clear(record);
      if (this.testRecycle.sourceIs(record)) {
        this.lastError = null;
        this.restartAttempt = 0;
        this.spawnNext();
        const replacement = this.current;
        if (!replacement || !this.testRecycle.bindReplacement(replacement)) {
          this.rejectTestRecycle(record, "The clean runtime replacement could not be started.", false);
        }
        return;
      }
      this.lastError = record.reportedFailure
        ?? this.lastError
        ?? `The runtime process exited unexpectedly (code ${code}).`;
      this.scheduleRestart();
    };
    if (record.processTreeTermination) {
      if (!record.processTreeTerminationSettled) {
        this.phase = "restarting";
        this.emitState();
        void record.processTreeTermination.then(continueAfterTermination);
        return;
      }
      continueAfterTermination(record.processTreeTerminationConfirmed);
      return;
    }
    continueAfterTermination(record.cleanupConfirmed);
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
  private post(child: UtilityProcess, message: RuntimeWorkerCommand): boolean {
    try {
      child.postMessage(message);
      return true;
    } catch (error) {
      this.lastError = publicProcessError(error, "The runtime process could not receive a lifecycle message.");
      const record = this.current;
      if (record?.child === child) {
        this.rejectTestRecycle(record, this.lastError, true);
      }
      this.forceTerminate(child);
      this.emitState();
      return false;
    }
  }
  private forceTerminate(child: UtilityProcess): void {
    const pid = child.pid;
    const record = this.current;
    if (pid && record?.child === child) {
      if (record.processTreeTermination) return;
      record.processTreeTerminationConfirmed = false;
      record.processTreeTerminationSettled = false;
      const deadlineAt = record.shutdownDeadlineAt
        ?? Date.now() + this.forceKillWaitMs * 2;
      let resolveTermination!: (confirmed: boolean) => void;
      const termination = new Promise<boolean>((resolve) => {
        resolveTermination = resolve;
      });
      record.processTreeTermination = termination;
      try {
        void Promise.resolve(this.forceKill(pid, deadlineAt)).then(
          (confirmed) => {
            resolveTermination(confirmed);
          },
          () => resolveTermination(false),
        );
      } catch {
        resolveTermination(false);
      }
      void termination.then((confirmed) => {
        record.processTreeTerminationConfirmed = confirmed;
        record.processTreeTerminationSettled = true;
        if (!confirmed && this.current === record) {
          this.lastError =
            "The runtime process tree could not be confirmed stopped.";
          this.emitState();
        }
      });
      return;
    }
    child.kill();
  }
  private completeGenerationCleanup(record: RuntimeProcessRecord): boolean {
    if (persistRuntimeGenerationCleanup(record, this.cleanupReceipts,
      this.runtimeGenerationLeases, this.runtimeOwnedProcesses)) {
      this.attachmentRequests.clear(record);
      return true;
    }
    record.processTreeTerminationConfirmed = false;
    this.rejectTestRecycle(
      record,
      "The confirmed runtime cleanup receipt could not be persisted.",
      true,
    );
    this.current = null;
    this.websocketUrl = null;
    this.clearShutdownTimers();
    this.quarantined.add(record);
    this.restartBlocked = true;
    this.desiredRunning = false;
    this.phase = "stopped";
    this.lastError = "The confirmed runtime cleanup receipt could not be persisted.";
    this.resolveStop?.(false);
    this.resolveStop = null;
    this.emitState();
    return false;
  }
  private clearShutdownTimers(): void {
    this.clearTimerValue("shutdownTimer");
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
  private rejectPrivateConnectRuntimeRequests(
    record: RuntimeProcessRecord | null,
    message: string,
  ): void {
    if (!record) return;
    for (const [requestId, pending] of this.pendingPrivateConnectRuntimeRequests) {
      if (pending.record !== record) continue;
      this.pendingPrivateConnectRuntimeRequests.delete(requestId);
      this.clearTimer(pending.timer);
      pending.reject(new Error(message));
    }
    this.privateConnectPrompts.reject(record, message);
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
    if (
      record.processTreeTermination
      && !record.processTreeTerminationSettled
    ) {
      void record.processTreeTermination.then(() =>
        this.settleStopped(record));
      return;
    }
    if (
      record.cleanupConfirmed
      && record.processTreeTerminationConfirmed
      && !this.completeGenerationCleanup(record)
    ) return;
    this.current = null;
    this.websocketUrl = null;
    this.clearShutdownTimers();
    this.phase = "stopped";
    if (!record.cleanupConfirmed || !record.processTreeTerminationConfirmed) {
      this.quarantined.add(record);
      this.restartBlocked = true;
      this.lastError = unconfirmedRuntimeCleanupMessage(
        this.systemBootId,
        "The runtime process tree could not be confirmed stopped.",
      );
    }
    else this.attachmentRequests.clear(record);
    this.emitState();
    this.resolveStop?.(
      record.cleanupConfirmed
        && record.processTreeTerminationConfirmed
        && this.quarantined.size === 0,
    );
    this.resolveStop = null;
  }
  private clearTimerValue(key: "restartTimer" | "startupTimer" | "stableTimer" | "shutdownTimer" | "shutdownDeadlineTimer"): void {
    const timer = this[key];
    if (!timer) return;
    this.clearTimer(timer);
    this[key] = null;
  }
  private emitState(): void {
    this.onStateChange?.(this.snapshot());
  }
}
