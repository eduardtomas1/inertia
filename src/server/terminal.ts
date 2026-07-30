import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { spawn, type IDisposable, type IPty } from "node-pty";
import WebSocket from "ws";

import type { ServerEvent } from "../shared/contracts";
import {
  forceTerminateProcessTreeByPidAndWait,
  type WaitForProcessExit,
} from "./process-lifecycle";

const MAX_TERMINALS = 8;
const MAX_TERMINALS_PER_CLIENT = 4;
const MAX_BUFFERED_OUTPUT = 1024 * 1024;
const OUTPUT_CHUNK_SIZE = 16 * 1024;
const TERMINAL_SHUTDOWN_TIMEOUT_MS = 1_000;
const TERMINAL_TREE_SHUTDOWN_TIMEOUT_MS = 1_000;

interface TerminalSession {
  id: string;
  owner: WebSocket;
  pty: IPty;
  dataListener: IDisposable;
  exitListener: IDisposable;
  onExit?: (exitCode: number) => void;
}

export interface TerminalManagerOptions {
  spawnTerminal?: typeof spawn;
  shutdownTimeoutMs?: number;
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

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_OUTPUT) {
    socket.terminate();
    return;
  }
  socket.send(JSON.stringify(event));
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly closingSessions = new Set<Promise<void>>();
  private readonly spawnTerminal: typeof spawn;
  private readonly shutdownTimeoutMs: number;
  private readonly terminateProcessTree: (
    pid: number,
    waitForExit: WaitForProcessExit,
  ) => Promise<boolean>;
  private closingFailure: Error | null = null;

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
    this.terminateProcessTree = options.terminateProcessTree
      ?? ((pid, waitForExit) => forceTerminateProcessTreeByPidAndWait(
        pid,
        waitForExit,
        { waitMs: TERMINAL_TREE_SHUTDOWN_TIMEOUT_MS },
      ));
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
    if (this.sessions.size >= MAX_TERMINALS) throw new TerminalError("The terminal session limit has been reached.");
    const ownerCount = [...this.sessions.values()].filter((session) => session.owner === owner).length;
    if (ownerCount >= MAX_TERMINALS_PER_CLIENT) throw new TerminalError("This window already has the maximum number of terminals.");

    const id = randomUUID();
    let pseudoterminal: IPty;
    try {
      pseudoterminal = this.spawnTerminal(executable, typeof args === "string" ? args : [...args], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch {
      throw new TerminalError("Unable to start a terminal for this project.");
    }

    const dataListener = pseudoterminal.onData((data) => {
      onOutput?.(data);
      for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_SIZE) {
        send(owner, { type: "terminal.output", terminalId: id, data: data.slice(offset, offset + OUTPUT_CHUNK_SIZE) });
      }
    });
    const exitListener = pseudoterminal.onExit(({ exitCode }) => {
      this.dispose(id, false);
      send(owner, { type: "terminal.exit", terminalId: id, exitCode });
      onExit?.(exitCode);
    });
    this.sessions.set(id, { id, owner, pty: pseudoterminal, dataListener, exitListener, onExit });
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
    this.ownedSession(owner, terminalId);
    this.dispose(terminalId, true);
  }

  /**
   * Stops a terminal previously registered to a scoped runtime operation.
   * This is intentionally not exposed through the client protocol by terminal
   * ID, so callers must first resolve an owned run on the server.
   */
  closeManaged(terminalId: string): boolean {
    if (!this.sessions.has(terminalId)) return false;
    this.dispose(terminalId, true);
    return true;
  }

  disposeOwner(owner: WebSocket): void {
    for (const session of this.sessions.values()) {
      if (session.owner === owner) this.trackDisposal(session);
    }
  }

  async disposeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.trackDisposal(session);
    }
    const failureBeforeWait = this.closingFailure;
    this.closingFailure = null;
    const closing = [...this.closingSessions];
    const results = await Promise.allSettled(closing);
    for (const promise of closing) this.closingSessions.delete(promise);
    const trackedFailure = this.closingFailure;
    this.closingFailure = null;
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    const failure = failureBeforeWait
      ?? trackedFailure
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

  private ownedSession(owner: WebSocket, terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session || session.owner !== owner) throw new TerminalError("Terminal not found.");
    return session;
  }

  private dispose(terminalId: string, kill: boolean): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    this.sessions.delete(terminalId);
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
      let escalating = false;
      let exitObserved = false;
      let resolveObservedExit!: () => void;
      const observedExit = new Promise<void>((resolveExit) => {
        resolveObservedExit = resolveExit;
      });
      const waitForExit: WaitForProcessExit = (waitMs) => {
        if (exitObserved) return Promise.resolve(true);
        return new Promise<boolean>((resolveWait) => {
          let waitSettled = false;
          const finishWait = (didExit: boolean): void => {
            if (waitSettled) return;
            waitSettled = true;
            clearTimeout(waitTimer);
            resolveWait(didExit);
          };
          const waitTimer = setTimeout(() => finishWait(false), waitMs);
          void observedExit.then(() => finishWait(true));
        });
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        exitListener.dispose();
        if (error) reject(error);
        else resolve();
      };
      const exitListener = session.pty.onExit(() => {
        exitObserved = true;
        resolveObservedExit();
        if (!escalating) finish();
      });
      const timer = setTimeout(() => {
        escalating = true;
        try {
          session.pty.kill();
        } catch {
          // The terminal may have exited while the timeout fired.
        }
        void this.terminateProcessTree(session.pty.pid, waitForExit).then(
          (confirmed) => finish(confirmed
            ? undefined
            : new TerminalError(
                "A terminal process tree could not be confirmed stopped during runtime shutdown.",
              )),
          () => finish(new TerminalError(
            "A terminal process tree could not be confirmed stopped during runtime shutdown.",
          )),
        );
      }, this.shutdownTimeoutMs);
      this.dispose(session.id, true);
    });
  }

  private trackDisposal(session: TerminalSession): void {
    const closing = this.disposeAndWait(session);
    this.closingSessions.add(closing);
    void closing.then(
      () => this.closingSessions.delete(closing),
      (error: unknown) => {
        this.closingSessions.delete(closing);
        this.closingFailure ??= error instanceof Error
          ? error
          : new TerminalError(
              "A terminal process did not exit during runtime shutdown.",
            );
      },
    );
  }
}

export class TerminalError extends Error {}
