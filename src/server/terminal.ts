import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { spawn, type IDisposable, type IPty } from "node-pty";
import WebSocket from "ws";

import type { ServerEvent } from "../shared/contracts";
import { spawnRuntimeOwnedPidProcess } from "../node/runtime-owned-processes";
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
  closing: Promise<void> | null;
  terminateProcessTree: OwnedPidProcessTreeTermination | null;
  confirmOwnedProcessStopped: () => boolean;
  flushOutput: () => void;
  disposeOutput: () => void;
  onExit?: (exitCode: number) => void;
}

export interface TerminalManagerOptions {
  spawnTerminal?: typeof spawn;
  shutdownTimeoutMs?: number;
  outputFlushMs?: number;
  createProcessTreeTermination?: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => OwnedPidProcessTreeTermination;
  terminateProcessTree?: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => Promise<boolean>;
}

function userShell(): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec || "powershell.exe", args: [] };
  }

  const configuredShell = process.env.SHELL;
  if (configuredShell && configuredShell.startsWith("/") && existsSync(configuredShell)) {
    return { executable: configuredShell, args: ["-l"] };
  }

  const fallback = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  return { executable: fallback, args: ["-l"] };
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
  private readonly createProcessTreeTermination: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => OwnedPidProcessTreeTermination;
  private readonly closingFailures = new Map<string, Error>();

  constructor(options: TerminalManagerOptions = {}) {
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
    const shell = userShell();
    return this.createProcess(owner, cwd, shell.executable, shell.args, process.env, cols, rows, onExit, onOutput);
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
      await this.trackDisposal(replaced);
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
  ): string {
    this.assertCapacity(owner, replaced);

    const id = randomUUID();
    let pseudoterminal: IPty;
    let confirmOwnedProcessStopped!: () => boolean;
    let releaseOwnedProcessIfExited!: () => void;
    try {
      const owned = spawnRuntimeOwnedPidProcess(() => this.spawnTerminal(
        executable,
        typeof args === "string" ? args : [...args],
        {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
        },
      ));
      pseudoterminal = owned.process;
      confirmOwnedProcessStopped = owned.confirmStopped;
      releaseOwnedProcessIfExited = owned.releaseIfGroupExited;
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
    const exitListener = pseudoterminal.onExit(({ exitCode }) => {
      flushOutput();
      session.exitObserved = true;
      for (const resolveExit of session.exitWaiters) resolveExit();
      session.exitWaiters.clear();
      releaseOwnedProcessIfExited();
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
      closing: null,
      terminateProcessTree: null,
      confirmOwnedProcessStopped,
      flushOutput,
      disposeOutput,
      onExit,
    };
    this.sessions.set(id, session);
    return id;
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

  async disposeAll(): Promise<void> {
    this.disposingAll = true;
    for (const session of this.sessions.values()) {
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

  private disposeAndWait(session: TerminalSession): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
      session.terminationRequested = true;
      // Start with the root still alive. On POSIX the terminator freezes it
      // before snapshotting descendants, preventing a prompt root exit from
      // reparenting a surviving background process beyond discovery.
      session.terminateProcessTree ??= this.createProcessTreeTermination(
        session.pty.pid,
        waitForExit,
      );
      void session.terminateProcessTree().then(
        (confirmed) => {
          if (!confirmed) {
            finish(new TerminalError(
              "A terminal process tree could not be confirmed stopped during runtime shutdown.",
            ));
            return;
          }
          this.dispose(session.id, false);
          if (!session.confirmOwnedProcessStopped()) {
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

  private trackDisposal(session: TerminalSession): Promise<void> {
    if (session.closing) return session.closing;
    const closing = this.disposeAndWait(session);
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
