import { randomUUID } from "node:crypto";

import { spawn, type IDisposable, type IPty } from "node-pty";
import WebSocket from "ws";

import type {
  ProviderTerminalResumeDescriptor,
} from "../shared/contracts";
import type {
  ProviderInstallationTransferredUse,
  ProviderInstallationUseTransfer,
} from "./provider/contracts";
import {
  spawnRuntimeOwnedPidProcess,
  type RuntimeOwnedPidProcess,
} from "../node/runtime-owned-processes";
import {
  createOwnedPidProcessTreeTermination,
  type OwnedPidProcessTreeTermination,
  type WaitForProcessExit,
} from "./process-lifecycle";
import { requestRecoveryFromTaintedOwnedProcess } from "./terminal-runtime-recovery";
import {
  terminalCloseTimeoutMs,
  terminalShutdownTimeoutMs,
} from "./terminal-shutdown-deadline";
import { beforeTerminalDeadline } from "./terminal-deadline";
import {
  runtimeOwnedPtyInvocationForBoundary,
  type TerminalOwnershipBoundary,
  userShell,
} from "./terminal-invocation";
import { createTerminalOutputBuffer } from "./terminal-output-buffer";
import { sendTerminalSocketEvent as send } from "./terminal-socket";
import { windowsCleanupFailures } from "./windows-cleanup-diagnostics";

const MAX_TERMINALS = 8;
const MAX_TERMINALS_PER_CLIENT = 4;
const OUTPUT_FLUSH_MS = 8;
const TERMINAL_REATTACH_TIMEOUT_MS = 30_000;

function boundedMilliseconds(value: number, maximum: number): number {
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

interface TerminalSession {
  id: string;
  owner: WebSocket | null;
  cwd: string;
  reattachScope: TerminalReattachScope | null;
  providerResume: TerminalProviderResumeAttachment | null;
  detachTimer: ReturnType<typeof setTimeout> | null;
  pty: IPty;
  dataListener: IDisposable;
  exitListener: IDisposable;
  exitObserved: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  exitWaiters: Set<() => void>;
  terminationRequested: boolean;
  supportsGracefulReplacement: boolean;
  closing: Promise<void> | null;
  shutdownDeadlineAt: number | null;
  waitForShutdownDeadline: Promise<number>;
  setShutdownDeadline(deadlineAt: number): void;
  terminateProcessTree: OwnedPidProcessTreeTermination | null;
  guardianExitCompletesDisposal: boolean | null;
  confirmOwnedProcessStopped: () => boolean;
  requestOwnedPayloadExit: () => boolean;
  requestOwnedGuardianStop: () => boolean;
  waitForOwnedGuardianStop: () => Promise<boolean>;
  flushOutput: () => void;
  detachOutput: () => void;
  replayOutput: (owner: WebSocket) => boolean;
  disposeOutput: () => void;
  onExit?: (exitCode: number) => void;
  installationUse: ProviderInstallationTransferredUse | null;
}

export interface TerminalManagerOptions {
  spawnTerminal?: typeof spawn;
  shutdownTimeoutMs?: number;
  closeTimeoutMs?: number;
  outputFlushMs?: number;
  reattachTimeoutMs?: number;
  platform?: NodeJS.Platform;
  createProcessTreeTermination?: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => OwnedPidProcessTreeTermination;
  terminateProcessTree?: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => Promise<boolean>;
  spawnOwnedTerminalProcess?: (
    spawnProcess: () => IPty,
    options: { readonly darwinGuardianCommand?: string },
  ) => RuntimeOwnedPidProcess<IPty>;
  onOwnedProcessCleanupUnconfirmed?: () => void;
  /** Test seam for exercising the fail-closed same-session Darwin retirement path. */
  preserveDarwinShellOnReplacement?: boolean;
}

export interface TerminalReattachScope {
  projectId: string;
  conversationId: string | null;
}

export type TerminalAttachment = {
  terminalId: string;
} & (
  | {
      providerResume: ProviderTerminalResumeDescriptor;
      providerResumeConversationId: string;
    }
  | {
      providerResume?: undefined;
      providerResumeConversationId?: undefined;
    }
);

export interface TerminalProviderResumeAttachment {
  descriptor: ProviderTerminalResumeDescriptor;
  conversationId: string;
}

async function waitForBooleanWithinTerminalDeadline(
  operation: Promise<boolean>,
  session: TerminalSession,
  localDeadlineAt: number | null,
): Promise<boolean> {
  if (session.shutdownDeadlineAt !== null) {
    return await beforeTerminalDeadline(
      operation,
      localDeadlineAt === null
        ? session.shutdownDeadlineAt
        : Math.min(localDeadlineAt, session.shutdownDeadlineAt),
    );
  }
  const boundedOperation = localDeadlineAt === null
    ? operation.catch(() => false)
    : beforeTerminalDeadline(operation, localDeadlineAt);
  const first = await Promise.race([
    boundedOperation.then((value) => ({ kind: "operation" as const, value })),
    session.waitForShutdownDeadline.then((deadlineAt) => ({
      kind: "deadline" as const,
      deadlineAt,
    })),
  ]);
  return first.kind === "operation"
    ? first.value
    : await beforeTerminalDeadline(
        operation,
        localDeadlineAt === null
          ? first.deadlineAt
          : Math.min(localDeadlineAt, first.deadlineAt),
      );
}

async function waitForGuardianStopWithinDeadline(
  session: TerminalSession,
  localDeadlineAt: number | null,
): Promise<boolean> {
  return await waitForBooleanWithinTerminalDeadline(
    session.waitForOwnedGuardianStop(),
    session,
    localDeadlineAt,
  );
}

async function waitForOwnedProcessStoppedWithinDeadline(
  session: TerminalSession,
  fallbackWaitMs: number,
  localDeadlineAt: number | null = null,
): Promise<boolean> {
  const initialDeadlineAt = localDeadlineAt
    ?? session.shutdownDeadlineAt
    ?? Date.now() + fallbackWaitMs;
  while (!session.confirmOwnedProcessStopped()) {
    const deadlineAt = session.shutdownDeadlineAt === null
      ? initialDeadlineAt
      : Math.min(initialDeadlineAt, session.shutdownDeadlineAt);
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(10, remainingMs));
      timer.unref();
    });
  }
  return true;
}

function ownershipRetirementFailure(session: TerminalSession): TerminalError {
  const outcome = session.exitObserved
    ? ` Guardian exit code: ${session.exitCode ?? "unknown"}; signal: ${session.exitSignal ?? "unknown"}.`
    : "";
  return new TerminalError(
    `A terminal process ownership claim could not be retired during runtime shutdown.${outcome}`,
  );
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly replacementReservations = new Map<string, TerminalSession>();
  private readonly distinctReplacements = new Map<string, {
    previousTerminalId: string;
    replacementTerminalId: string;
  }>();
  private readonly closingSessions = new Set<Promise<void>>();
  private disposingAll = false;
  private updatePreparationHeld = false;
  private readonly spawnTerminal: typeof spawn;
  private readonly shutdownTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly outputFlushMs: number;
  private readonly reattachTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly createProcessTreeTermination: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => OwnedPidProcessTreeTermination;
  private readonly spawnOwnedTerminalProcess: (
    spawnProcess: () => IPty,
    options: { readonly darwinGuardianCommand?: string },
  ) => RuntimeOwnedPidProcess<IPty>;
  private readonly onOwnedProcessCleanupUnconfirmed: () => void;
  private readonly preserveDarwinShellOnReplacement: boolean;
  private readonly closingFailures = new Map<string, Error>();

  constructor(options: TerminalManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnTerminal = options.spawnTerminal ?? spawn;
    this.shutdownTimeoutMs = boundedMilliseconds(
      options.shutdownTimeoutMs ?? terminalShutdownTimeoutMs(this.platform),
      30_000,
    );
    this.closeTimeoutMs = boundedMilliseconds(
      options.closeTimeoutMs ?? terminalCloseTimeoutMs(this.platform),
      30_000,
    );
    this.outputFlushMs = boundedMilliseconds(
      options.outputFlushMs ?? OUTPUT_FLUSH_MS,
      50,
    );
    this.reattachTimeoutMs = boundedMilliseconds(
      options.reattachTimeoutMs ?? TERMINAL_REATTACH_TIMEOUT_MS,
      120_000,
    );
    this.spawnOwnedTerminalProcess = options.spawnOwnedTerminalProcess
      ?? spawnRuntimeOwnedPidProcess;
    this.onOwnedProcessCleanupUnconfirmed =
      options.onOwnedProcessCleanupUnconfirmed ?? (() => undefined);
    this.preserveDarwinShellOnReplacement =
      options.preserveDarwinShellOnReplacement ?? true;
    const terminateProcessTree = options.terminateProcessTree;
    this.createProcessTreeTermination = options.createProcessTreeTermination
      ?? ((pid, waitForExit) => {
        if (terminateProcessTree) {
          return () => terminateProcessTree(pid, waitForExit);
        }
        return createOwnedPidProcessTreeTermination(
          pid,
          waitForExit,
          { waitMs: this.shutdownTimeoutMs },
        );
      });
  }

  create(
    owner: WebSocket,
    cwd: string,
    cols: number,
    rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
    reattachScope: TerminalReattachScope | null = null,
  ): string {
    const shell = userShell(this.platform);
    return this.createProcessReplacing(
      owner,
      null,
      cwd,
      shell.executable,
      shell.args,
      process.env,
      cols,
      rows,
      onExit,
      onOutput,
      this.platform === "darwin",
      reattachScope,
      null,
      "terminal-session",
    );
  }

  async replace(
    owner: WebSocket,
    terminalId: string,
    cwd: string,
    cols: number,
    rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
    replacementRequestId?: string,
  ): Promise<string> {
    const shell = userShell(this.platform);
    return await this.replaceProcessWithBoundary(
      owner,
      terminalId,
      cwd,
      shell.executable,
      shell.args,
      process.env,
      cols,
      rows,
      onExit,
      onOutput,
      null,
      this.platform === "darwin",
      replacementRequestId,
      "terminal-session",
    );
  }

  attach(
    owner: WebSocket,
    terminalId: string,
    cwd: string,
    scope: TerminalReattachScope,
    cols: number,
    rows: number,
    replacementRequestId?: string,
  ): TerminalAttachment {
    if (this.disposingAll || this.updatePreparationHeld) {
      throw new TerminalError("The terminal service is stopping.");
    }
    const replacement = replacementRequestId
      ? this.distinctReplacements.get(replacementRequestId)
      : undefined;
    if (
      replacementRequestId
      && (!replacement || replacement.previousTerminalId !== terminalId)
    ) {
      throw new TerminalError("Terminal replacement not found.");
    }
    const replacementId = replacement?.previousTerminalId === terminalId
      ? replacement.replacementTerminalId
      : undefined;
    const session = this.sessions.get(replacementId ?? terminalId);
    if (
      !session
      || session.cwd !== cwd
      || session.reattachScope?.projectId !== scope.projectId
      || session.reattachScope.conversationId !== scope.conversationId
    ) {
      throw new TerminalError("Terminal not found.");
    }
    if (owner.readyState !== WebSocket.OPEN) {
      throw new TerminalError("The terminal client disconnected.");
    }
    if (session.terminationRequested || session.closing) {
      const failure = this.closingFailures.get(session.id);
      if (!failure) {
        throw new TerminalError(
          "The terminal process is still stopping. Retry reconnecting.",
        );
      }
      // A reconnect may be the only remaining authority able to retry a
      // failed process-tree retirement. Transfer only that cleanup capability;
      // input, resize, and replay remain unavailable while termination is
      // pending.
      session.owner = owner;
      if (session.detachTimer) clearTimeout(session.detachTimer);
      session.detachTimer = null;
      throw new TerminalError(failure.message);
    }
    this.assertCapacity(owner, session, scope);
    // Keep the former owner authoritative until resize and bounded replay both
    // succeed. A failed transfer must not evict a still-healthy renderer.
    session.flushOutput();
    try {
      session.pty.resize(cols, rows);
    } catch {
      throw new TerminalError("Unable to resize this terminal.");
    }
    if (!session.replayOutput(owner)) {
      throw new TerminalError("The terminal client disconnected.");
    }
    if (session.detachTimer) clearTimeout(session.detachTimer);
    session.detachTimer = null;
    session.owner = owner;
    if (session.providerResume) {
      return {
        terminalId: session.id,
        providerResume: session.providerResume.descriptor,
        providerResumeConversationId: session.providerResume.conversationId,
      };
    }
    return { terminalId: session.id };
  }

  createProcess(
    owner: WebSocket,
    cwd: string,
    executable: string,
    args: readonly string[] | string,
    env: NodeJS.ProcessEnv,
    cols: number,
    rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
    installationUse?: ProviderInstallationUseTransfer,
  ): string {
    try {
      return this.createProcessReplacing(
        owner,
        null,
        cwd,
        executable,
        args,
        env,
        cols,
        rows,
        onExit,
        onOutput,
        false,
        null,
        null,
        "complete-tree",
        installationUse,
      );
    } catch (error) {
      installationUse?.abandonBeforeSpawn();
      throw error;
    }
  }

  async replaceProcess(
    owner: WebSocket,
    terminalId: string,
    cwd: string,
    executable: string,
    args: readonly string[] | string,
    env: NodeJS.ProcessEnv,
    cols: number,
    rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
    providerResume: TerminalProviderResumeAttachment | null = null,
    replacementSupportsGracefulRetirement = false,
    replacementRequestId?: string,
    installationUse?: ProviderInstallationUseTransfer,
  ): Promise<string> {
    try {
      return await this.replaceProcessWithBoundary(
        owner,
        terminalId,
        cwd,
        executable,
        args,
        env,
        cols,
        rows,
        onExit,
        onOutput,
        providerResume,
        replacementSupportsGracefulRetirement,
        replacementRequestId,
        "complete-tree",
        installationUse,
      );
    } catch (error) {
      installationUse?.abandonBeforeSpawn();
      throw error;
    }
  }

  private async replaceProcessWithBoundary(
    owner: WebSocket,
    terminalId: string,
    cwd: string,
    executable: string,
    args: readonly string[] | string,
    env: NodeJS.ProcessEnv,
    cols: number,
    rows: number,
    onExit: ((exitCode: number) => void) | undefined,
    onOutput: ((data: string) => void) | undefined,
    providerResume: TerminalProviderResumeAttachment | null,
    replacementSupportsGracefulRetirement: boolean,
    replacementRequestId: string | undefined,
    ownershipBoundary: TerminalOwnershipBoundary,
    installationUse?: ProviderInstallationUseTransfer,
  ): Promise<string> {
    const replaced = this.ownedSession(owner, terminalId);
    if (replaced.cwd !== cwd) {
      throw new TerminalError(
        "The terminal does not belong to this project workspace.",
      );
    }
    if (owner.readyState !== WebSocket.OPEN) {
      throw new TerminalError("The terminal client disconnected.");
    }
    if (
      this.platform === "darwin"
      && replaced.supportsGracefulReplacement
      && this.preserveDarwinShellOnReplacement
    ) {
      // Preserve an interactive macOS shell under its visible identity when a
      // provider process starts beside it. The provider receives a separate,
      // strict complete-tree guardian instead of inheriting the shell's
      // terminal-session ownership boundary.
      const replacementId = this.createProcessReplacing(
        owner,
        null,
        cwd,
        executable,
        args,
        env,
        cols,
        rows,
        onExit,
        onOutput,
        replacementSupportsGracefulRetirement,
        replaced.reattachScope,
        providerResume,
        ownershipBoundary,
        installationUse,
      );
      if (replacementRequestId && this.sessions.has(replacementId)) {
        this.distinctReplacements.set(replacementRequestId, {
          previousTerminalId: replaced.id,
          replacementTerminalId: replacementId,
        });
      }
      return replacementId;
    }
    this.assertCapacity(owner, replaced, replaced.reattachScope);
    this.replacementReservations.set(replaced.id, replaced);
    try {
      await this.trackReplacementDisposal(replaced);
      // The replacement keeps the same public terminal identity. Publishing
      // an intermediate exit would make the renderer discard the only safe
      // capability it can use to reconcile an ambiguously delivered result.
      if (owner.readyState !== WebSocket.OPEN) {
        throw new TerminalError("The terminal client disconnected.");
      }
      const replacementId = this.createProcessReplacing(
        owner,
        replaced,
        cwd,
        executable,
        args,
        env,
        cols,
        rows,
        onExit,
        onOutput,
        replacementSupportsGracefulRetirement,
        replaced.reattachScope,
        providerResume,
        ownershipBoundary,
        installationUse,
      );
      if (replacementRequestId && this.sessions.has(replacementId)) {
        this.distinctReplacements.set(replacementRequestId, {
          previousTerminalId: replaced.id,
          replacementTerminalId: replacementId,
        });
      }
      return replacementId;
    } finally {
      this.replacementReservations.delete(replaced.id);
    }
  }

  private assertCapacity(
    owner: WebSocket,
    replaced: TerminalSession | null,
    reattachScope: TerminalReattachScope | null = null,
  ): void {
    if (this.disposingAll || this.updatePreparationHeld) {
      throw new TerminalError("The terminal service is stopping.");
    }
    const failedRetirement = [...this.sessions.values()].some((session) => (
      this.closingFailures.has(session.id)
      && (
        reattachScope === null
          ? session.owner === owner
          : session.reattachScope?.projectId === reattachScope.projectId
            && session.reattachScope.conversationId === reattachScope.conversationId
      )
    ));
    if (failedRetirement) {
      throw new TerminalError(
        "A previous terminal process could not be confirmed stopped. Retry closing it before starting another terminal.",
      );
    }
    const reservedOnly = [...this.replacementReservations.values()].filter(
      (session) => !this.sessions.has(session.id),
    );
    const replacementAllowance = replaced ? 1 : 0;
    if (
      this.sessions.size + reservedOnly.length - replacementAllowance
      >= MAX_TERMINALS
    ) {
      throw new TerminalError("The terminal session limit has been reached.");
    }
    const ownerCount = [...this.sessions.values(), ...reservedOnly].filter(
      (session) => (
        session !== replaced
        && (
          session.owner === owner
          || (
            reattachScope !== null
            && session.reattachScope?.projectId === reattachScope.projectId
            && session.reattachScope.conversationId
              === reattachScope.conversationId
          )
        )
      ),
    ).length;
    if (ownerCount >= MAX_TERMINALS_PER_CLIENT) {
      throw new TerminalError(
        "This window already has the maximum number of terminals.",
      );
    }
  }

  holdForUpdatePreparation(): void {
    this.updatePreparationHeld = true;
  }

  releaseUpdatePreparation(): void {
    if (!this.disposingAll) this.updatePreparationHeld = false;
  }

  hasUpdateBlockingActivity(): boolean {
    return this.sessions.size > 0
      || this.replacementReservations.size > 0
      || this.closingSessions.size > 0
      || this.closingFailures.size > 0;
  }

  ownedResourceCount(): number {
    return new Set([
      ...this.sessions.keys(),
      ...this.replacementReservations.keys(),
    ]).size;
  }

  private createProcessReplacing(
    owner: WebSocket,
    replaced: TerminalSession | null,
    cwd: string,
    executable: string,
    args: readonly string[] | string,
    env: NodeJS.ProcessEnv,
    cols: number,
    rows: number,
    onExit?: (exitCode: number) => void,
    onOutput?: (data: string) => void,
    supportsGracefulReplacement = false,
    reattachScope: TerminalReattachScope | null = null,
    providerResume: TerminalProviderResumeAttachment | null = null,
    ownershipBoundary: TerminalOwnershipBoundary = "complete-tree",
    installationUse?: ProviderInstallationUseTransfer,
  ): string {
    this.assertCapacity(owner, replaced, reattachScope);

    // Replacement shells retain their public identity. If delivery of the
    // replacement response is ambiguous, the renderer can safely reconcile by
    // attaching the same terminal ID instead of leaking an unknown process.
    const id = replaced?.id ?? randomUUID();
    let settleShutdownDeadline!: (deadlineAt: number) => void;
    const waitForShutdownDeadline = new Promise<number>((resolve) => {
      settleShutdownDeadline = resolve;
    });
    let pseudoterminal: IPty;
    let confirmOwnedProcessStopped!: () => boolean;
    let releaseOwnedProcessIfExited!: (exitSignal?: number) => void;
    let requestOwnedPayloadExit!: () => boolean;
    let requestOwnedGuardianStop!: () => boolean;
    let waitForOwnedGuardianStop!: () => Promise<boolean>;
    let transferredInstallationUse: ProviderInstallationTransferredUse | null = null;
    try {
      const invocation = runtimeOwnedPtyInvocationForBoundary(
        this.platform,
        ownershipBoundary,
        executable,
        args,
      );
      transferredInstallationUse = installationUse?.accept() ?? null;
      if (installationUse && !transferredInstallationUse) {
        throw new TerminalError(
          "Provider installation authority was already consumed.",
        );
      }
      const owned = this.spawnOwnedTerminalProcess(() => this.spawnTerminal(
        invocation.command,
        invocation.args,
        {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        },
      ), { darwinGuardianCommand: invocation.command });
      pseudoterminal = owned.process;
      confirmOwnedProcessStopped = owned.confirmStopped;
      releaseOwnedProcessIfExited = owned.releaseIfGroupExited;
      requestOwnedPayloadExit = owned.requestPayloadExit ?? (() => false);
      requestOwnedGuardianStop = owned.requestGuardianStop;
      waitForOwnedGuardianStop = owned.waitForGuardianStop;
    } catch {
      if (transferredInstallationUse) {
        transferredInstallationUse.quarantine(
          "terminal-provider-spawn-outcome-uncertain",
        );
      } else {
        installationUse?.abandonBeforeSpawn();
      }
      requestRecoveryFromTaintedOwnedProcess(this.onOwnedProcessCleanupUnconfirmed);
      throw new TerminalError("Unable to start a terminal for this project.");
    }

    let session!: TerminalSession;
    const output = createTerminalOutputBuffer({
      terminalId: id,
      retainHistory: reattachScope !== null,
      flushMs: this.outputFlushMs,
      getDeliveryOwner: () => session ? session.owner : owner,
      hasAttachedOwner: () => Boolean(session?.owner),
      onDeliveryFailure: (failedOwner) => {
        if (!session || session.owner !== failedOwner) return;
        session.owner = null;
        session.detachOutput();
        if (session.reattachScope) this.scheduleDetachedDisposal(session);
        else void this.trackFinalDisposal(session);
      },
    });
    const dataListener = pseudoterminal.onData((data) => {
      onOutput?.(data);
      output.queue(data);
    });
    const exitListener = pseudoterminal.onExit(({ exitCode, signal }) => {
      output.flush();
      session.exitObserved = true;
      session.exitCode = exitCode;
      session.exitSignal = signal ?? null;
      for (const resolveExit of session.exitWaiters) resolveExit();
      session.exitWaiters.clear();
      releaseOwnedProcessIfExited(signal);
      const ownsProviderInstallation = session.installationUse !== null;
      const ownedProcessStopped = session.confirmOwnedProcessStopped();
      if (
        !session.terminationRequested
        && (
          (signal !== 0 && !ownedProcessStopped)
          || (
            ownsProviderInstallation
            && (
              !ownedProcessStopped
              || !this.releaseInstallationUse(session)
            )
          )
        )
      ) {
        this.quarantineInstallationUse(
          session,
          "terminal-provider-natural-exit-cleanup-unconfirmed",
        );
        session.terminationRequested = true;
        this.recordCleanupFailure(session, ownershipRetirementFailure(session));
        return;
      }
      if (session.terminationRequested) return;
      const exitOwner = session.owner;
      this.dispose(id, false);
      if (exitOwner) {
        send(exitOwner, { type: "terminal.exit", terminalId: id, exitCode });
      }
      onExit?.(exitCode);
    });
    session = {
      id,
      owner,
      cwd,
      reattachScope,
      providerResume,
      detachTimer: null,
      pty: pseudoterminal,
      dataListener,
      exitListener,
      exitObserved: false,
      exitCode: null,
      exitSignal: null,
      exitWaiters: new Set(),
      terminationRequested: false,
      supportsGracefulReplacement,
      closing: null,
      shutdownDeadlineAt: null,
      waitForShutdownDeadline,
      setShutdownDeadline: (deadlineAt) => {
        if (
          session.shutdownDeadlineAt !== null
          && deadlineAt >= session.shutdownDeadlineAt
        ) return;
        session.shutdownDeadlineAt = deadlineAt;
        settleShutdownDeadline(deadlineAt);
      },
      terminateProcessTree: null,
      guardianExitCompletesDisposal: null,
      confirmOwnedProcessStopped,
      requestOwnedPayloadExit,
      requestOwnedGuardianStop,
      waitForOwnedGuardianStop,
      flushOutput: output.flush,
      detachOutput: output.detach,
      replayOutput: output.replay,
      disposeOutput: output.dispose,
      onExit,
      installationUse: transferredInstallationUse,
    };
    this.sessions.set(id, session);
    return id;
  }

  private async gracefullyRetireReplacementShell(
    session: TerminalSession,
  ): Promise<boolean> {
    // The native guardian gates the shell until asynchronous admission proves
    // its exact identity and installs the durable claim. Do not spend the
    // interactive-shell exit budget—or queue input for a shell that cannot
    // run yet—before that boundary settles.
    if (!await waitForGuardianStopWithinDeadline(
      session,
      Date.now() + this.shutdownTimeoutMs,
    )) return false;
    const gracefulDeadlineAt = Date.now()
      + this.shutdownTimeoutMs;
    // Ask the authenticated native guardian to signal only the exact payload
    // root. Never inject bytes into a terminal that may contain a partial user
    // command or have a foreground application consuming input.
    if (!session.requestOwnedPayloadExit()) return false;
    while (!session.exitObserved || !session.confirmOwnedProcessStopped()) {
      const deadlineAt = Math.min(
        gracefulDeadlineAt,
        session.shutdownDeadlineAt ?? gracefulDeadlineAt,
      );
      const remainingMs = Math.trunc(deadlineAt - Date.now());
      if (remainingMs <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(10, remainingMs));
        timer.unref();
      });
    }
    return true;
  }

  input(owner: WebSocket, terminalId: string, data: string): void {
    this.ownedSession(owner, terminalId).pty.write(data);
  }

  resize(owner: WebSocket, terminalId: string, cols: number, rows: number): void {
    try {
      this.ownedSession(owner, terminalId).pty.resize(cols, rows);
    } catch {
      throw new TerminalError("Unable to resize this terminal.");
    }
  }

  detach(owner: WebSocket, terminalId: string): void {
    const session = this.ownedSession(owner, terminalId);
    if (!session.reattachScope) {
      throw new TerminalError("This terminal cannot be reattached.");
    }
    session.flushOutput();
    session.owner = null;
    session.detachOutput();
    this.scheduleDetachedDisposal(session);
  }

  async close(owner: WebSocket, terminalId: string): Promise<void> {
    const session = this.ownedSession(owner, terminalId, true);
    const initiated = session.closing === null;
    await this.trackFinalDisposal(session);
    if (initiated) {
      send(owner, {
        type: "terminal.exit",
        terminalId: session.id,
        exitCode: 130,
      });
    }
  }

  /**
   * Stops a terminal previously registered to a scoped runtime operation.
   * This is intentionally not exposed through the client protocol by terminal
   * ID, so callers must first resolve an owned run on the server.
   */
  async closeManaged(terminalId: string): Promise<boolean> {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    await this.trackFinalDisposal(session);
    return true;
  }

  disposeOwner(owner: WebSocket): void {
    for (const session of this.sessions.values()) {
      if (session.owner === owner) {
        if (session.reattachScope && !session.terminationRequested) {
          session.owner = null;
          session.detachOutput();
          this.scheduleDetachedDisposal(session);
        } else {
          if (session.reattachScope) session.owner = null;
          void this.trackFinalDisposal(session);
        }
      }
    }
  }

  private scheduleDetachedDisposal(session: TerminalSession): void {
    if (
      session.owner !== null
      || session.terminationRequested
      || session.closing
      || session.detachTimer
    ) return;
    const timer = setTimeout(() => {
      if (session.detachTimer !== timer) return;
      session.detachTimer = null;
      if (session.owner !== null || session.terminationRequested) return;
      void this.trackFinalDisposal(session);
    }, this.reattachTimeoutMs);
    timer.unref();
    session.detachTimer = timer;
  }

  async disposeAll(deadlineAt?: number): Promise<void> {
    this.disposingAll = true;
    for (const session of this.sessions.values()) {
      if (session.detachTimer) clearTimeout(session.detachTimer);
      session.detachTimer = null;
      if (deadlineAt !== undefined) {
        session.setShutdownDeadline(deadlineAt);
      }
      void this.trackFinalDisposal(session);
    }
    const closing = [...this.closingSessions];
    const results = await Promise.allSettled(closing);
    for (const promise of closing) this.closingSessions.delete(promise);
    const trackedFailure = this.closingFailures.values().next().value;
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    const failure = trackedFailure
      ?? (
        rejected?.reason instanceof Error
          ? rejected.reason
          : rejected
            ? new TerminalError(
                "A terminal process did not exit during runtime shutdown.",
              )
            : null
      );
    if (failure) throw failure;
  }

  private ownedSession(
    owner: WebSocket,
    terminalId: string,
    includeTerminating = false,
  ): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (
      !session
      || session.owner !== owner
      || (session.terminationRequested && !includeTerminating)
    ) {
      throw new TerminalError("Terminal not found.");
    }
    return session;
  }

  private releaseInstallationUse(session: TerminalSession): boolean {
    const use = session.installationUse;
    if (!use) return true;
    session.installationUse = null;
    return use.release({ cleanupConfirmed: true });
  }

  private quarantineInstallationUse(
    session: TerminalSession,
    reason: string,
  ): void {
    const use = session.installationUse;
    if (!use) return;
    session.installationUse = null;
    use.quarantine(reason);
  }

  private dispose(terminalId: string, kill: boolean): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    for (const [requestId, replacement] of this.distinctReplacements) {
      if (replacement.replacementTerminalId === terminalId) {
        this.distinctReplacements.delete(requestId);
      }
    }
    if (session.detachTimer) clearTimeout(session.detachTimer);
    session.detachTimer = null;
    session.disposeOutput();
    session.dataListener.dispose();
    session.exitListener.dispose();
    if (kill) {
      this.quarantineInstallationUse(
        session,
        "terminal-provider-disposed-without-cleanup-proof",
      );
      try {
        session.pty.kill();
      } catch {
        // The process may have exited between lookup and disposal.
      }
      session.onExit?.(130);
    }
  }

  private async disposeAndWait(
    session: TerminalSession,
    attemptGracefulReplacement: boolean,
  ): Promise<void> {
    // Let trackDisposal publish the memoized closing promise before a graceful
    // payload exit can synchronously trigger the PTY exit listener.
    await Promise.resolve();
    if (
      attemptGracefulReplacement
      && await this.gracefullyRetireReplacementShell(session)
    ) {
      if (!this.releaseInstallationUse(session)) {
        throw ownershipRetirementFailure(session);
      }
      this.dispose(session.id, false);
      try {
        session.onExit?.(130);
      } catch {
        // The exact durable claim is already retired.
      }
      return;
    }
    // One ordinary-close envelope includes asynchronous admission plus the
    // stop proof; the authoritative runtime-shutdown deadline can tighten it.
    const fallbackDeadlineAt = session.shutdownDeadlineAt === null
      ? Date.now() + this.closeTimeoutMs
      : null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const waitForExit: WaitForProcessExit = (waitMs) => {
        if (session.exitObserved) return Promise.resolve(true);
        return new Promise<boolean>((resolveWait) => {
          let waitSettled = false;
          const finishWait = (didExit: boolean): void => {
            if (waitSettled) return;
            waitSettled = true;
            clearTimeout(waitTimer);
            session.exitWaiters.delete(observeExit);
            resolveWait(didExit);
          };
          const observeExit = (): void => finishWait(true);
          session.exitWaiters.add(observeExit);
          const waitTimer = setTimeout(() => finishWait(false), waitMs);
        });
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      // Start with the root still alive. On POSIX the terminator freezes it
      // before snapshotting descendants, preventing a prompt root exit from
      // reparenting a surviving background process beyond discovery.
      if (session.terminateProcessTree === null) {
        const unconfirmedExitedGuardian = session.exitObserved
          && this.closingFailures.has(session.id);
        session.guardianExitCompletesDisposal = !unconfirmedExitedGuardian
          && session.requestOwnedGuardianStop();
        session.terminateProcessTree = unconfirmedExitedGuardian
          ? async () => false
          : session.guardianExitCompletesDisposal
          ? async () => {
            // A close can race the platform guardian's bounded asynchronous
            // admission. Let that exact guardian consume the recorded stop
            // request before starting the shorter PTY-exit deadline.
            const admitted = await waitForGuardianStopWithinDeadline(
              session,
              fallbackDeadlineAt,
            );
            if (!admitted) return false;
            const exited = session.exitObserved
              ? true
              : await waitForBooleanWithinTerminalDeadline(
                  waitForExit(this.shutdownTimeoutMs),
                  session,
                  fallbackDeadlineAt,
                );
            return exited;
          }
          : this.createProcessTreeTermination(session.pty.pid, waitForExit);
      }
      void session.terminateProcessTree().then(
        async (confirmed) => {
          if (!confirmed) {
            this.quarantineInstallationUse(
              session,
              "terminal-provider-cleanup-unconfirmed",
            );
            finish(new TerminalError(
              "A terminal process tree could not be confirmed stopped during runtime shutdown.",
              process.platform === "win32"
                ? { cause: { windowsCleanupFailures: windowsCleanupFailures() } }
                : undefined,
            ));
            return;
          }
          // A native guardian exit proves only that the local PTY handle is
          // gone. Replacement also requires the exact durable ownership claim
          // to be retired; a fork-tainted guardian exit deliberately keeps it
          // live so an escaped descendant cannot run beside a new session.
          if (!await waitForOwnedProcessStoppedWithinDeadline(
            session,
            this.shutdownTimeoutMs,
            fallbackDeadlineAt,
          )) {
            this.quarantineInstallationUse(
              session,
              "terminal-provider-ownership-retirement-unconfirmed",
            );
            finish(ownershipRetirementFailure(session));
            return;
          }
          if (!this.releaseInstallationUse(session)) {
            finish(ownershipRetirementFailure(session));
            return;
          }
          this.dispose(session.id, false);
          try {
            session.onExit?.(130);
          } catch {
            // The owned tree is already confirmed stopped; lifecycle
            // observers must not turn that confirmation into a retryable leak.
          }
          finish();
        },
        () => {
          this.quarantineInstallationUse(
            session,
            "terminal-provider-cleanup-rejected",
          );
          finish(new TerminalError(
            "A terminal process tree could not be confirmed stopped during runtime shutdown.",
            process.platform === "win32"
              ? { cause: { windowsCleanupFailures: windowsCleanupFailures() } }
              : undefined,
          ));
        },
      );
    });
  }

  private trackFinalDisposal(session: TerminalSession): Promise<void> {
    return this.trackDisposal(session, false);
  }

  private trackReplacementDisposal(session: TerminalSession): Promise<void> {
    return this.trackDisposal(session, session.supportsGracefulReplacement);
  }

  private trackDisposal(
    session: TerminalSession,
    attemptGracefulReplacement: boolean,
  ): Promise<void> {
    if (session.closing) return session.closing;
    if (session.detachTimer) clearTimeout(session.detachTimer);
    session.detachTimer = null;
    session.terminationRequested = true;
    const closing = this.disposeAndWait(session, attemptGracefulReplacement);
    session.closing = closing;
    this.closingSessions.add(closing);
    void closing.then(
      () => {
        this.closingSessions.delete(closing);
        this.closingFailures.delete(session.id);
        if (session.closing === closing) session.closing = null;
      },
      (error: unknown) => {
        this.closingSessions.delete(closing);
        const failure = error instanceof Error
          ? error
          : new TerminalError(
              "A terminal process did not exit during runtime shutdown.",
            );
        this.recordCleanupFailure(session, failure);
        if (session.closing === closing) session.closing = null;
      },
    );
    return closing;
  }

  private recordCleanupFailure(session: TerminalSession, failure: Error): void {
    const firstFailure = !this.closingFailures.has(session.id);
    if (!firstFailure) return;
    this.closingFailures.set(session.id, failure);
    try { this.onOwnedProcessCleanupUnconfirmed(); } catch {
      // Cleanup remains fail-closed even if the outer restart signal fails.
    }
  }
}

export class TerminalError extends Error {}
