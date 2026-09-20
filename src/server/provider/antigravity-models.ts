import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import {
  awaitRuntimeOwnedProcessStopped,
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";
import type { ProviderModel } from "../../shared/contracts";
import { providerChildEnvironment } from "../environment";
import {
  createOwnedProcessTreeTermination,
  ProcessTreeTerminationError,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { providerProcessInvocation } from "./process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_MODELS = 128;
const PROCESS_SUBJECT = "Antigravity model discovery process tree";

function catalogError(): Error {
  // Neither stdout nor stderr belongs in errors: login diagnostics can contain
  // account information. Keep unsuccessful reads unavailable/stale in the cache.
  return new Error("Antigravity model discovery did not return a valid catalog.");
}

/** The documented `agy models` format is two columns: slug and display name. */
export function parseAntigravityModels(output: string): ProviderModel[] {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw catalogError();
  const lines = stripVTControlCharacters(output).split(/\r?\n/u)
    .map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_MODELS) throw catalogError();
  const ids = new Set<string>();
  return lines.map((line) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9._:/-]{0,159})(?:\t+| {2,})(\S.{0,119})$/u.exec(line);
    if (
      !match
      || match[1] === "provider-default"
      || ids.has(match[1]!)
      || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(match[2]!)
    ) throw catalogError();
    const id = match[1]!;
    const label = match[2]!;
    ids.add(id);
    return {
      id,
      label,
      description: "Available through Antigravity CLI",
      isDefault: false,
      inputModalities: ["text"],
      reasoningOptions: [],
      defaultReasoningEffort: "",
      fastMode: null,
    };
  });
}

export interface AntigravityModelReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
  /** Deterministic deadline seam; production starts its deadline at spawn. */
  scheduleDeadline?: (onDeadline: () => void, timeoutMs: number) => { cancel(): void };
}

function scheduleDeadline(onDeadline: () => void, timeoutMs: number): { cancel(): void } {
  const timer = setTimeout(onDeadline, timeoutMs);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

/** Catalog only: no prompt, authentication attempt, or provider settings access. */
export async function readAntigravityModels(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  options: AntigravityModelReadOptions = {},
): Promise<ProviderModel[]> {
  if (options.signal?.aborted) throw catalogError();
  const requestedTimeout = options.timeoutMs ?? 6_000;
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(requestedTimeout, 20_000)) : 6_000;
  return await new Promise<ProviderModel[]>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      const env = { ...providerChildEnvironment("antigravity", environment), NO_COLOR: "1" };
      const invocation = providerProcessInvocation(executable, ["models"], env);
      const owned = runtimeOwnedProcessInvocation(invocation.command, invocation.args);
      child = spawnRuntimeOwnedProcess(() => spawn(owned.command, owned.args, {
        cwd, env, shell: false, detached: process.platform !== "win32",
        windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"],
      }), "provider-capability");
    } catch {
      reject(catalogError());
      return;
    }

    const terminate = createOwnedProcessTreeTermination(
      child, PROCESS_SUBJECT, options.terminateProcessTree,
    );
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let stopping = false;
    let closing = false;
    let failed = false;
    let deadline: { cancel(): void } | undefined;
    const finish = (error?: Error, models?: ProviderModel[]): void => {
      if (settled) return;
      settled = true;
      deadline?.cancel();
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(models!);
    };
    const stop = (): void => {
      failed = true;
      if (settled || stopping || closing) return;
      stopping = true;
      deadline?.cancel();
      void terminate(true).then(
        () => finish(catalogError()),
        () => finish(new ProcessTreeTerminationError(PROCESS_SUBJECT)),
      );
    };
    const abort = (): void => stop();
    const append = (chunk: Buffer, capture: boolean): void => {
      if (settled || stopping) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) stop();
      else if (capture) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, false));
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.once("error", stop);
    child.once("close", (code) => {
      if (settled || stopping) return;
      closing = true;
      deadline?.cancel();
      // A successful exit is not enough: join the guardian's retirement before
      // publishing metadata or releasing the installation lease.
      void awaitRuntimeOwnedProcessStopped(child).then((confirmed) => {
        if (!confirmed) return finish(new ProcessTreeTerminationError(PROCESS_SUBJECT));
        if (failed || options.signal?.aborted || code !== 0) return finish(catalogError());
        try {
          finish(undefined, parseAntigravityModels(Buffer.concat(stdout).toString("utf8")));
        } catch {
          finish(catalogError());
        }
      }, () => finish(new ProcessTreeTerminationError(PROCESS_SUBJECT)));
    });
    deadline = (options.scheduleDeadline ?? scheduleDeadline)(stop, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end();
    if (options.signal?.aborted) abort();
  });
}
