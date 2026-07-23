import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { spawn, type IDisposable, type IPty } from "node-pty";
import WebSocket from "ws";

import type { ServerEvent } from "../shared/contracts";

const MAX_TERMINALS = 8;
const MAX_TERMINALS_PER_CLIENT = 4;
const MAX_BUFFERED_OUTPUT = 1024 * 1024;
const OUTPUT_CHUNK_SIZE = 16 * 1024;

interface TerminalSession {
  id: string;
  owner: WebSocket;
  pty: IPty;
  dataListener: IDisposable;
  exitListener: IDisposable;
  onExit?: (exitCode: number) => void;
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
      pseudoterminal = spawn(executable, typeof args === "string" ? args : [...args], {
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
    for (const session of [...this.sessions.values()]) {
      if (session.owner === owner) this.dispose(session.id, true);
    }
  }

  disposeAll(): void {
    for (const terminalId of [...this.sessions.keys()]) this.dispose(terminalId, true);
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
}

export class TerminalError extends Error {}
