import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { spawn, type IDisposable, type IPty } from "node-pty";
import WebSocket from "ws";

import type { ServerEvent } from "../shared/contracts";
import {
  spawnRuntimeOwnedPidProcess,
  type RuntimeOwnedPidProcess,
} from "../node/runtime-owned-processes";
import { runtimeOwnedPtyInvocation } from "../node/runtime-owned-pty-invocation";
import {
  createOwnedPidProcessTreeTermination,
  type OwnedPidProcessTreeTermination,
  type WaitForProcessExit,
} from "./process-lifecycle";

const MAX_TERMINALS = 8;
const MAX_TERMINALS_PER_CLIENT = 4;
const MAX_BUFFERED_OUTPUT = 1024 * 1024;
const OUTPUT_CHUNK_CODE_UNITS = 16 * 1024;
const OUTPUT_FLUSH_MS = 8;
// node-pty's Windows ConPTY backend intentionally delays its public exit event
// for 1 second while output drains. Leave bounded headroom for that signal and
// the final resource-settle check while still finishing well before the
// supervisor's 3-second process-tree fallback.
const TERMINAL_SHUTDOWN_TIMEOUT_MS = process.platform === "win32"
  ? 1_500
  : 1_000;

interface TerminalSession {
  id: string;
  owner: WebSocket;
  cwd: string;
  pty: IPty;
  dataListener: IDisposable;
  exitListener: IDisposable;
  exitObserved: boolean;
  exitWaiters: Set<() => void>;
  terminationRequested: boolean;
  gracefulReplacement: boolean;
  closing: Promise<void> | null;
  shutdownDeadlineAt: number | null;
  waitForShutdownDeadline: Promise<number>;
  setShutdownDeadline(deadlineAt: number): void;
  terminateProcessTree: OwnedPidProcessTreeTermination | null;
  guardianExitCompletesDisposal: boolean | null;
  confirmOwnedProcessStopped: () => boolean;
  requestOwnedGuardianStop: () => boolean;
  waitForOwnedGuardianStop: () => Promise<boolean>;
  flushOutput: () => void;
  disposeOutput: () => void;
  onExit?: (exitCode: number) => void;
}

export interface TerminalManagerOptions {
  spawnTerminal?: typeof spawn;
  shutdownTimeoutMs?: number;
  outputFlushMs?: number;
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
}

function userShell(platform: NodeJS.Platform): { executable: string; args: string[] } {
  if (platform === "win32") {
    return { executable: process.env.ComSpec || "powershell.exe", args: [] };
  }

  const configuredShell = process.env.SHELL;
  if (configuredShell && configuredShell.startsWith("/") && existsSync(configuredShell)) {
    return { executable: configuredShell, args: ["-l"] };
  }

  const fallback = platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return { executable: fallback, args: ["-l"] };
}

async function beforeTerminalDeadline(
  operation: Promise<boolean>,
  deadlineAt: number,
): Promise<boolean> {
  type Settlement =
    | { kind: "pending" }
    | { kind: "settled"; value: boolean };
  const settlement: { current: Settlement } = { current: { kind: "pending" } };
  const observedSettlement = (): Settlement => settlement.current;
  void operation.then(
    (value) => { settlement.current = { kind: "settled", value }; },
    () => { settlement.current = { kind: "settled", value: false }; },
  );
  await Promise.resolve();
  const immediate = observedSettlement();
  if (immediate.kind === "settled") return immediate.value;
  const remainingMs = Math.trunc(deadlineAt - Date.now());
  if (remainingMs <= 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const delayed = observedSettlement();
    return delayed.kind === "settled"
      ? delayed.value
      : false;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), remainingMs);
    timer.unref();
    void operation.then(finish, () => finish(false));
  });
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
  const fallbackDeadlineAt = localDeadlineAt
    ?? Date.now() + fallbackWaitMs;
  while (!session.confirmOwnedProcessStopped()) {
    const deadlineAt = session.shutdownDeadlineAt === null
      ? fallbackDeadlineAt
      : Math.min(fallbackDeadlineAt, session.shutdownDeadlineAt);
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(10, remainingMs));
      timer.unref();
    });
  }
  return true;
}

function stopSlowSocket(socket: WebSocket): void {
  try {
    socket.terminate();
  } catch {
    // A concurrent close may already have released the transport.
  }
}

function send(socket: WebSocket, event: ServerEvent): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > MAX_BUFFERED_OUTPUT) {
    stopSlowSocket(socket);
    return false;
  }
  try {
    socket.send(JSON.stringify(event));
    return true;
  } catch {
    stopSlowSocket(socket);
    return false;
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly replacementReservations = new Map<string, TerminalSession>();
  private readonly closingSessions = new Set<Promise<void>>();
  private disposingAll = false;
  private updatePreparationHeld = false;
  private readonly spawnTerminal: typeof spawn;
  private readonly shutdownTimeoutMs: number;
  private readonly outputFlushMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly createProcessTreeTermination: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => OwnedPidProcessTreeTermination;
  private readonly spawnOwnedTerminalProcess: (
    spawnProcess: () => IPty,
    options: { readonly darwinGuardianCommand?: string },
  ) => RuntimeOwnedPidProcess<IPty>;
  private readonly closingFailures = new Map<string, Error>();

  constructor(options: TerminalManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnTerminal = options.spawnTerminal ?? spawn;
    this.shutdownTimeoutMs = Math.max(
      1,
      Math.min(
        Math.trunc(
          options.shutdownTimeoutMs ?? TERMINAL_SHUTDOWN_TIMEOUT_MS,
        ),
        30_000,
      ),
    );
    this.outputFlushMs = Math.max(
      1,
      Math.min(Math.trunc(options.outputFlushMs ?? OUTPUT_FLUSH_MS), 50),
    );
    this.spawnOwnedTerminalProcess = options.spawnOwnedTerminalProcess
      ?? spawnRuntimeOwnedPidProcess;
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
    );
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
  ): string {
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
    );
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
    this.assertCapacity(owner, replaced);
    this.replacementReservations.set(replaced.id, replaced);
    try {
      await this.trackDisposal(replaced, replaced.gracefulReplacement);
      if (
        owner.readyState !== WebSocket.OPEN
        || !send(owner, {
          type: "terminal.exit",
          terminalId: replaced.id,
          exitCode: 130,
        })
      ) {
        throw new TerminalError("The terminal client disconnected.");
      }
      return this.createProcessReplacing(
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
      );
    } finally {
      this.replacementReservations.delete(replaced.id);
    }
  }

  private assertCapacity(
    owner: WebSocket,
    replaced: TerminalSession | null,
  ): void {
    if (this.disposingAll || this.updatePreparationHeld) {
      throw new TerminalError("The terminal service is stopping.");
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
      (session) => session.owner === owner && session !== replaced,
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
    gracefulReplacement = false,
  ): string {
    this.assertCapacity(owner, replaced);

    const id = randomUUID();
    let settleShutdownDeadline!: (deadlineAt: number) => void;
    const waitForShutdownDeadline = new Promise<number>((resolve) => {
      settleShutdownDeadline = resolve;
    });
    let pseudoterminal: IPty;
    let confirmOwnedProcessStopped!: () => boolean;
    let releaseOwnedProcessIfExited!: (exitSignal?: number) => void;
    let requestOwnedGuardianStop!: () => boolean;
    let waitForOwnedGuardianStop!: () => Promise<boolean>;
    try {
      const invocation = runtimeOwnedPtyInvocation(executable, args);
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
      requestOwnedGuardianStop = owned.requestGuardianStop;
      waitForOwnedGuardianStop = owned.waitForGuardianStop;
    } catch {
      throw new TerminalError("Unable to start a terminal for this project.");
    }

    let session!: TerminalSession;
    let pendingOutput = "";
    let outputTimer: ReturnType<typeof setTimeout> | null = null;
    let outputTransportOpen = true;
    const sendOutput = (data: string): boolean => {
      if (!outputTransportOpen) return false;
      outputTransportOpen = send(owner, {
        type: "terminal.output",
        terminalId: id,
        data,
      });
      return outputTransportOpen;
    };
    const flushOutput = (): void => {
      if (outputTimer) {
        clearTimeout(outputTimer);
        outputTimer = null;
      }
      while (pendingOutput.length > 0) {
        const data = pendingOutput.slice(0, OUTPUT_CHUNK_CODE_UNITS);
        pendingOutput = pendingOutput.slice(data.length);
        if (!sendOutput(data)) {
          pendingOutput = "";
          break;
        }
      }
    };
    const queueOutput = (data: string): void => {
      if (!outputTransportOpen) return;
      pendingOutput += data;
      while (pendingOutput.length >= OUTPUT_CHUNK_CODE_UNITS) {
        const chunk = pendingOutput.slice(0, OUTPUT_CHUNK_CODE_UNITS);
        pendingOutput = pendingOutput.slice(OUTPUT_CHUNK_CODE_UNITS);
        if (!sendOutput(chunk)) {
          pendingOutput = "";
          return;
        }
      }
      if (pendingOutput.length > 0 && !outputTimer) {
        outputTimer = setTimeout(flushOutput, this.outputFlushMs);
        outputTimer.unref();
      }
    };
    const disposeOutput = (): void => {
      flushOutput();
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = null;
    };
    const dataListener = pseudoterminal.onData((data) => {
      onOutput?.(data);
      queueOutput(data);
    });
    const exitListener = pseudoterminal.onExit(({ exitCode, signal }) => {
      flushOutput();
      session.exitObserved = true;
      for (const resolveExit of session.exitWaiters) resolveExit();
      session.exitWaiters.clear();
      releaseOwnedProcessIfExited(signal);
      if (session.terminationRequested) return;
      this.dispose(id, false);
      send(owner, { type: "terminal.exit", terminalId: id, exitCode });
      onExit?.(exitCode);
    });
    session = {
      id,
      owner,
      cwd,
      pty: pseudoterminal,
      dataListener,
      exitListener,
      exitObserved: false,
      exitWaiters: new Set(),
      terminationRequested: false,
      gracefulReplacement,
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
      requestOwnedGuardianStop,
      waitForOwnedGuardianStop,
      flushOutput,
      disposeOutput,
      onExit,
    };
    this.sessions.set(id, session);
    return id;
  }

  private async gracefullyRetireReplacementShell(
    session: TerminalSession,
  ): Promise<boolean> {
    const gracefulDeadlineAt = Date.now()
      + Math.max(1, Math.trunc(this.shutdownTimeoutMs / 2));
    try {
      // A local interactive shell can retire the Darwin guardian normally
      // through PTY EOF. Provider/action terminals are never sent input by
      // replacement and continue through the fail-closed stop path below.
      session.pty.write("\x04");
    } catch {
      return false;
    }
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

  close(owner: WebSocket, terminalId: string): void {
    const session = this.ownedSession(owner, terminalId, true);
    if (session.closing) return;
    void this.trackDisposal(session).then(
      () => {
        send(owner, {
          type: "terminal.exit",
          terminalId: session.id,
          exitCode: 130,
        });
      },
      () => undefined,
    );
  }

  /**
   * Stops a terminal previously registered to a scoped runtime operation.
   * This is intentionally not exposed through the client protocol by terminal
   * ID, so callers must first resolve an owned run on the server.
   */
  async closeManaged(terminalId: string): Promise<boolean> {
    const session = this.sessions.get(terminalId);
    if (!session) return false;
    await this.trackDisposal(session);
    return true;
  }

  disposeOwner(owner: WebSocket): void {
    for (const session of this.sessions.values()) {
      if (session.owner === owner) void this.trackDisposal(session);
    }
  }

  async disposeAll(deadlineAt?: number): Promise<void> {
    this.disposingAll = true;
    for (const session of this.sessions.values()) {
      if (deadlineAt !== undefined) {
        session.setShutdownDeadline(deadlineAt);
      }
      void this.trackDisposal(session);
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

  private dispose(terminalId: string, kill: boolean): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
    session.disposeOutput();
    session.dataListener.dispose();
    session.exitListener.dispose();
    if (kill) {
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
    gracefulReplacement: boolean,
  ): Promise<void> {
    // Let trackDisposal publish the memoized closing promise before EOF can
    // synchronously trigger the PTY exit listener.
    await Promise.resolve();
    let fallbackDeadlineAt: number | null = null;
    if (
      gracefulReplacement
      && await this.gracefullyRetireReplacementShell(session)
    ) {
      this.dispose(session.id, false);
      try {
        session.onExit?.(130);
      } catch {
        // The exact durable claim is already retired.
      }
      return;
    }
    if (gracefulReplacement) {
      // The EOF prepass is an optional convenience for an interactive Darwin
      // shell. Give the fail-closed guardian path its complete configured
      // budget when no enclosing runtime-shutdown deadline is already tighter.
      fallbackDeadlineAt = Date.now() + this.shutdownTimeoutMs;
    }

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
        session.guardianExitCompletesDisposal = session.requestOwnedGuardianStop();
        session.terminateProcessTree = session.guardianExitCompletesDisposal
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
            finish(new TerminalError(
              "A terminal process tree could not be confirmed stopped during runtime shutdown.",
            ));
            return;
          }
          this.dispose(session.id, false);
          // A native guardian exit proves only that the local PTY handle is
          // gone. Replacement also requires the exact durable ownership claim
          // to be retired; a fork-tainted guardian exit deliberately keeps it
          // live so an escaped descendant cannot run beside a new session.
          if (!await waitForOwnedProcessStoppedWithinDeadline(
            session,
            this.shutdownTimeoutMs,
            fallbackDeadlineAt,
          )) {
            finish(new TerminalError(
              "A terminal process ownership claim could not be retired during runtime shutdown.",
            ));
            return;
          }
          try {
            session.onExit?.(130);
          } catch {
            // The owned tree is already confirmed stopped; lifecycle
            // observers must not turn that confirmation into a retryable leak.
          }
          finish();
        },
        () => finish(new TerminalError(
          "A terminal process tree could not be confirmed stopped during runtime shutdown.",
        )),
      );
    });
  }

  private trackDisposal(
    session: TerminalSession,
    gracefulReplacement = false,
  ): Promise<void> {
    if (session.closing) return session.closing;
    session.terminationRequested = true;
    const closing = this.disposeAndWait(session, gracefulReplacement);
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
        this.closingFailures.set(session.id, error instanceof Error
          ? error
          : new TerminalError(
              "A terminal process did not exit during runtime shutdown.",
            ));
        if (session.closing === closing) session.closing = null;
      },
    );
    return closing;
  }
}

export class TerminalError extends Error {}
