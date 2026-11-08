import { spawn, type ChildProcess } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CursorSdkChannel } from "../../node/cursor-sdk-channel";
import { runtimeOwnedProcessInvocation, runtimeOwnedProcessStopConfirmation, spawnRuntimeOwnedProcess } from "../../node/runtime-owned-processes";
import { credentialFreeProviderEnvironment } from "../environment";
import { createOwnedProcessTreeTermination } from "../process-lifecycle";
import { nodeRuntimeFileSystem, nodeRuntimeOnPath } from "./node-runtime";

export class CursorSdkCleanupError extends Error {
  readonly code = "process-tree-termination-unconfirmed";
  constructor(readonly child: ChildProcess) { super("Cursor SDK worker cleanup is unconfirmed."); }
}

export function cursorSdkWorkerPath(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  return join(basename(directory) === "chunks" ? dirname(directory) : directory, "cursor-sdk-worker.js").replace(/([/\\])app\.asar([/\\])/u, "$1app.asar.unpacked$2");
}

export async function openCursorSdkWorker(options: {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  handle(method: string, params: unknown): Promise<unknown>;
}, dependencies: { workerPath?: string } = {}) {
  options.signal.throwIfAborted();
  const environment = credentialFreeProviderEnvironment(options.environment);
  const node = nodeRuntimeOnPath(environment, {
    platform: process.platform, fileSystem: nodeRuntimeFileSystem,
    electronExecutable: process.versions.electron ? process.execPath : undefined,
  });
  if (!node || (process.platform === "win32" && process.arch !== "x64")) throw new Error("Cursor SDK requires an external Node 22.13+ runtime on a supported platform.");
  const worker = dependencies.workerPath ?? cursorSdkWorkerPath();
  await access(worker);
  const cwd = await realpath(options.cwd);
  if (cwd !== options.cwd) throw new Error("Cursor SDK workspace must be canonical.");
  options.signal.throwIfAborted();
  const invocation = runtimeOwnedProcessInvocation(node, ["--no-warnings", worker]);
  const child = spawnRuntimeOwnedProcess(() => spawn(invocation.command, invocation.args, {
    cwd, env: environment, shell: false, detached: process.platform !== "win32", windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }));
  const terminate = createOwnedProcessTreeTermination(child, "Cursor SDK worker process tree");
  let closing: Promise<void> | undefined;
  let channel: CursorSdkChannel;
  const close = (): Promise<void> => {
    closing ??= terminate(true);
    void closing.catch(() => undefined);
    return closing;
  };
  channel = new CursorSdkChannel(child.stdout, child.stdin, options.handle, () => { void close(); });
  const stop = (): void => { channel.close(); void close(); };
  options.signal.addEventListener("abort", stop, { once: true });
  let diagnosticBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => { diagnosticBytes += chunk.length; if (diagnosticBytes > 1024 * 1024) stop(); });
  child.once("error", stop);
  child.once("exit", stop);
  try {
    if (runtimeOwnedProcessStopConfirmation(child) === null) throw new Error("Cursor SDK worker has no ownership enrollment.");
    const hello = await channel.request("hello", null, 10_000) as { version?: unknown; node?: unknown } | null;
    if (!hello || hello.version !== "1.0.38" || typeof hello.node !== "string" || !/^22\.(?:1[3-9]|[2-9]\d)\./u.test(hello.node)) throw new Error("Cursor SDK worker runtime verification failed.");
    options.signal.throwIfAborted();
    return { child, channel, close: async () => {
      options.signal.removeEventListener("abort", stop);
      channel.close();
      await close();
    } };
  } catch {
    options.signal.removeEventListener("abort", stop);
    channel.close();
    try { await close(); } catch { throw new CursorSdkCleanupError(child); }
    throw new Error("Cursor SDK worker startup failed.");
  }
}
