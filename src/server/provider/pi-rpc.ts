import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { runtimeOwnedProcessInvocation, spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";
import { JsonLineDecoder, objectValue, type JsonObject } from "../codex/protocol";
import { createOwnedProcessTreeTermination, type ProcessTreeTerminator } from "../process-lifecycle";
import type { ProviderInstallationUseTransfer } from "./contracts";
import { providerProcessInvocation } from "./process";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_INPUT_BYTES = 96 * 1024 * 1024;
const MAX_PENDING = 64;

export interface PiRpcOptions {
  executable: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  cwd: string;
  onEvent?: (event: JsonObject) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  installationUse?: ProviderInstallationUseTransfer;
  spawnProcess?: typeof spawn;
  terminateProcessTree?: ProcessTreeTerminator;
}

export interface PiRpcConnection {
  child: ChildProcessWithoutNullStreams;
  /** Resolves once on unexpected transport/protocol failure; never rejects unobserved. */
  failure: Promise<Error>;
  request(command: string, params?: JsonObject, timeoutMs?: number): Promise<unknown>;
  send(record: JsonObject): void;
  close(force?: boolean): Promise<void>;
}

interface Pending {
  command: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** Pi 1.0 JSONL transport: LF only, exact IDs, bounded I/O, one owned process tree. */
export function openPiRpcConnection(options: PiRpcOptions): PiRpcConnection {
  options.signal?.throwIfAborted();
  const invocation = providerProcessInvocation(options.executable, options.args, options.environment);
  const owned = runtimeOwnedProcessInvocation(invocation.command, invocation.args);
  const installation = options.installationUse?.accept();
  if (options.installationUse && !installation) throw new Error("Pi installation authority was already consumed.");
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnRuntimeOwnedProcess(() => (options.spawnProcess ?? spawn)(owned.command, owned.args, {
      cwd: options.cwd, env: options.environment, shell: false,
      detached: process.platform !== "win32", windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (error) {
    installation?.quarantine("pi-spawn-outcome-uncertain");
    throw error;
  }
  const terminate = createOwnedProcessTreeTermination(child, "Pi RPC process tree", options.terminateProcessTree);
  const pending = new Map<string, Pending>();
  const prefix = `inertia-${randomUUID()}`;
  let nextId = 0;
  let inputBytes = 0;
  let stderrBytes = 0;
  let closing = false;
  let error: Error | undefined;
  let stopped: Promise<void> | undefined;
  let decoder: JsonLineDecoder;
  let reportFailure!: (error: Error) => void;
  const failure = new Promise<Error>((resolve) => { reportFailure = resolve; });

  const rejectPending = (reason: Error): void => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(reason); }
    pending.clear();
  };
  const stop = (force: boolean): Promise<void> => {
    if (!stopped) stopped = terminate(force).then(() => {
      installation?.release({ cleanupConfirmed: true });
    }, (reason: unknown) => {
      installation?.quarantine("pi-cleanup-unconfirmed");
      throw reason;
    });
    else if (force) void terminate(true).catch(() => undefined);
    return stopped;
  };
  const fail = (reason: Error): void => {
    if (closing || error) return;
    error = reason;
    decoder?.stop();
    rejectPending(reason);
    reportFailure(reason);
    void stop(true).catch(() => undefined);
  };
  const send = (record: JsonObject): void => {
    if (closing || error) throw error ?? new Error("Pi RPC connection is closed.");
    const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    inputBytes += encoded.length;
    if (encoded.length > MAX_FRAME_BYTES || inputBytes > MAX_INPUT_BYTES
      || child.stdin.writableLength + encoded.length > MAX_FRAME_BYTES) {
      const reason = new Error("Pi RPC input exceeded its safety limit."); fail(reason); throw reason;
    }
    child.stdin.write(encoded, (reason) => { if (reason) fail(new Error("Pi RPC input failed.")); });
  };
  const request = (command: string, params: JsonObject = {}, requestedTimeout?: number): Promise<unknown> => {
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many pending Pi RPC requests."));
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(command)) return Promise.reject(new Error("Invalid Pi RPC command."));
    const id = `${prefix}-${++nextId}`;
    const configuredTimeout = requestedTimeout ?? options.timeoutMs ?? 30_000;
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(1, Math.min(configuredTimeout, 300_000)) : 30_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`Pi RPC ${command} timed out.`)), timeoutMs);
      timer.unref();
      pending.set(id, { command, resolve, reject, timer });
      try { send({ ...params, id, type: command }); }
      catch (reason) {
        clearTimeout(timer); pending.delete(id);
        reject(reason instanceof Error ? reason : new Error("Pi RPC input failed."));
      }
    });
  };
  decoder = new JsonLineDecoder(MAX_FRAME_BYTES, (line) => {
    if (!line.trim()) return;
    let record: JsonObject | undefined;
    try { record = objectValue(JSON.parse(line)); }
    catch { fail(new Error("Pi returned malformed JSON.")); return; }
    if (!record || typeof record.type !== "string") { fail(new Error("Pi returned a malformed record.")); return; }
    if (record.type !== "response") {
      try { options.onEvent?.(record); }
      catch { fail(new Error("Pi returned an invalid event.")); }
      return;
    }
    const active = typeof record.id === "string" ? pending.get(record.id) : undefined;
    if (!active || record.command !== active.command || typeof record.success !== "boolean") {
      fail(new Error("Pi returned an uncorrelated response.")); return;
    }
    pending.delete(record.id as string);
    clearTimeout(active.timer);
    if (record.success) active.resolve(record.data);
    // Do not expose provider errors which can contain environment credentials.
    else active.reject(new Error(`Pi rejected ${active.command}.`));
  }, () => fail(new Error("Pi output exceeded its safety limit or contained invalid UTF-8.")), MAX_OUTPUT_BYTES);
  const abort = (): void => fail(new Error("Pi RPC was cancelled."));
  options.signal?.addEventListener("abort", abort, { once: true });
  child.stdin.on("error", () => fail(new Error("Pi RPC input failed.")));
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 256 * 1024) fail(new Error("Pi diagnostic output exceeded its safety limit."));
  });
  child.stdout.once("end", () => { decoder.end(); fail(new Error("Pi closed its protocol output before settling.")); });
  child.once("error", () => fail(new Error("Pi process could not start.")));
  child.once("close", () => fail(new Error("Pi process exited before settling.")));
  if (options.signal?.aborted) abort();
  return {
    child, failure, request, send,
    close: async (force = true) => {
      closing = true;
      decoder.stop();
      options.signal?.removeEventListener("abort", abort);
      rejectPending(new Error("Pi RPC connection closed."));
      await stop(force);
    },
  };
}
