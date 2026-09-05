import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { INERTIA_VERSION } from "../../shared/version";
import {
  confirmRuntimeOwnedProcessStopped,
  runtimeOwnedProcessInvocation,
  spawnRuntimeOwnedProcess,
} from "../../node/runtime-owned-processes";
import {
  isProcessTreeTerminationUnconfirmed,
  ProcessTreeTerminationError,
  requireProcessTreeTermination,
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "../process-lifecycle";
import { providerProcessInvocation } from "../provider/process";
import type { ProviderInstallationUseTransfer } from
  "../provider/contracts";
import {
  JsonLineDecoder,
  objectValue,
  rpcId,
  type JsonLineDecoderFailure,
  type JsonObject,
} from "./protocol";
import {
  codexCurrentTimeReadResult,
  isCodexCurrentTimeReadMethod,
  parseCodexCurrentTimeRead,
  parseCodexProviderThreadId,
} from "./app-server-requests";

export const CODEX_CONTROL_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const CODEX_CONTROL_MAX_PROTOCOL_BYTES = 16 * 1024 * 1024;

interface PendingRequest {
  method: string;
  providerThreadId?: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexControlClient {
  request(method: string, params?: JsonObject): Promise<JsonObject>;
}

export interface CodexControlClientOptions {
  executable: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs?: number;
  terminateProcessTree?: ProcessTreeTerminator;
  processLabel?: string;
  spawnProcess?: typeof spawn;
  signal?: AbortSignal;
  onNotification?: (method: string, params: JsonObject) => void;
  installationUse?: ProviderInstallationUseTransfer;
}

function boundedErrorMessage(value: unknown): string | undefined {
  const message = objectValue(value)?.message;
  if (typeof message !== "string") return undefined;
  const clean = message.replaceAll("\0", "").trim();
  return clean ? clean.slice(0, 500) : undefined;
}

/**
 * Opens a bounded, one-shot Codex App Server connection for control-plane
 * reads and mutations. The child and every pending request are always settled
 * before the callback returns.
 */
export async function withCodexControlClient<T>(
  options: CodexControlClientOptions,
  runWithClient: (client: CodexControlClient) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) {
    throw new Error("Codex control request was cancelled.");
  }
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? 6_000, 30_000));
  const terminateProcessTree = options.terminateProcessTree
    ?? terminateProcessTreeAndWait;
  const invocation = providerProcessInvocation(
    options.executable,
    ["app-server"],
    options.environment,
  );
  const spawnProcess = options.spawnProcess ?? spawn;
  const ownedInvocation = runtimeOwnedProcessInvocation(
    invocation.command,
    invocation.args,
  );
  const installationUse = options.installationUse?.accept();
  if (options.installationUse && !installationUse) {
    throw new Error("Codex control installation authority was already consumed.");
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnRuntimeOwnedProcess(() => spawnProcess(
      ownedInvocation.command,
      ownedInvocation.args,
      {
        cwd: options.cwd,
        env: options.environment,
        detached: process.platform !== "win32",
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ));
  } catch (error) {
    installationUse?.quarantine("codex-control-spawn-outcome-uncertain");
    throw error;
  }
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;
  let connectionError: Error | undefined;
  let termination: Promise<void> | undefined;
  let decoder: JsonLineDecoder | undefined;
  let rejectConnection!: (error: Error) => void;
  const connectionFailure = new Promise<never>((_, reject) => {
    rejectConnection = reject;
  });
  child.stderr.resume();

  const rejectPending = (error: Error): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const stopProcessTree = (): Promise<void> => {
    termination ??= requireProcessTreeTermination(
      terminateProcessTree,
      child,
      true,
      options.processLabel ?? "Codex control process tree",
    ).then(() => {
      if (!confirmRuntimeOwnedProcessStopped(child)) {
        throw new ProcessTreeTerminationError(
          options.processLabel ?? "Codex control process tree",
        );
      }
    });
    return termination;
  };
  const failConnection = (error: Error): void => {
    if (closed || connectionError) return;
    connectionError = error;
    decoder?.stop();
    rejectPending(error);
    rejectConnection(error);
    void stopProcessTree().catch(() => undefined);
  };
  const abortConnection = (): void => {
    failConnection(new Error("Codex control request was cancelled."));
  };
  options.signal?.addEventListener("abort", abortConnection, { once: true });
  child.stdin.on("error", () => {
    failConnection(new Error("Codex control input stream failed."));
  });
  child.once("error", () => {
    failConnection(new Error("Codex control process could not start."));
  });
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      decoder?.stop();
      rejectPending(new Error("Codex control request was interrupted."));
    }
    await stopProcessTree();
  };
  const writeMessage = (message: JsonObject): boolean => {
    if (closed || connectionError) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          failConnection(new Error("Codex control input stream failed."));
        }
      });
      return true;
    } catch {
      failConnection(new Error("Codex control input stream failed."));
      return false;
    }
  };
  const request = (
    method: string,
    params: JsonObject = {},
  ): Promise<JsonObject> => new Promise((resolve, reject) => {
    if (closed || connectionError) {
      reject(
        connectionError
          ?? new Error("Codex control connection is closed."),
      );
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, timeoutMs);
    timer.unref();
    const providerThreadId = parseCodexProviderThreadId(params);
    pending.set(id, {
      method,
      ...(providerThreadId ? { providerThreadId } : {}),
      resolve,
      reject,
      timer,
    });
    writeMessage({ id, method, params });
  });
  const notify = (method: string, params: JsonObject = {}): void => {
    writeMessage({ method, params });
  };
  const handleLine = (line: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      failConnection(new Error("Codex control returned malformed JSON."));
      return;
    }
    const message = objectValue(parsed);
    const messageId = rpcId(message?.id);
    const id = typeof messageId === "number" ? messageId : undefined;
    const method = typeof message?.method === "string"
      ? message.method
      : undefined;
    if (messageId !== undefined && method !== undefined) {
      const params = objectValue(message?.params) ?? {};
      const currentTimeRead = parseCodexCurrentTimeRead(method, params);
      if (
        currentTimeRead
        && [...pending.values()].some(
          ({ providerThreadId }) =>
            providerThreadId === currentTimeRead.threadId,
        )
      ) {
        writeMessage({ id: messageId, result: codexCurrentTimeReadResult() });
        return;
      }
      if (isCodexCurrentTimeReadMethod(method)) {
        const requestFailure = currentTimeRead
          ? "Codex control requested the current time for an unowned provider thread."
          : "Codex control received a malformed current-time request.";
        writeMessage({
          id: messageId,
          error: { code: -32602, message: requestFailure },
        });
        failConnection(new Error(requestFailure));
        return;
      }
      // This one-shot control client has no UI/durable-turn route for server
      // requests such as approvals or elicitation. Never confuse a colliding
      // server request ID with the response to one of our pending requests.
      failConnection(new Error(
        `Codex control received unexpected server request '${method}'.`,
      ));
      return;
    }
    if (id === undefined) {
      if (method) {
        try {
          options.onNotification?.(
            method,
            objectValue(message?.params) ?? {},
          );
        } catch {
          // Control observers cannot interrupt the owned protocol lifecycle.
        }
      }
      return;
    }
    const active = pending.get(id);
    if (!active) return;
    pending.delete(id);
    clearTimeout(active.timer);
    if (message?.error) {
      active.reject(new Error(
        boundedErrorMessage(message.error) ?? `${active.method} failed.`,
      ));
    } else {
      active.resolve(objectValue(message?.result) ?? {});
    }
  };
  const failProtocol = (failure: JsonLineDecoderFailure): void => {
    failConnection(new Error(
      failure === "malformed-utf8"
        ? "Codex control returned invalid UTF-8."
        : "Codex control exceeded Inertia's protocol safety limit.",
    ));
  };

  decoder = new JsonLineDecoder(
    CODEX_CONTROL_MAX_FRAME_BYTES,
    handleLine,
    failProtocol,
    CODEX_CONTROL_MAX_PROTOCOL_BYTES,
  );
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
  child.stdout.once("end", () => {
    decoder?.end();
    failConnection(new Error("Codex control output closed early."));
  });
  child.once("close", () => {
    failConnection(new Error("Codex control process exited early."));
  });

  let operationFailed = false;
  let operationError: unknown;
  let operationResult!: T;
  try {
    await Promise.race([
      request("initialize", {
        clientInfo: {
          name: "inertia",
          title: "Inertia",
          version: INERTIA_VERSION,
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      }),
      connectionFailure,
    ]);
    notify("initialized");
    operationResult = await Promise.race([
      runWithClient({ request }),
      connectionFailure,
    ]);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  options.signal?.removeEventListener("abort", abortConnection);
  try {
    await close();
  } catch (cleanupError) {
    installationUse?.quarantine("codex-control-cleanup-unconfirmed");
    if (
      !operationFailed
      || !isProcessTreeTerminationUnconfirmed(cleanupError)
    ) {
      throw cleanupError;
    }
    throw new ProcessTreeTerminationError(
      options.processLabel ?? "Codex control process tree",
      {
        priorError: operationError,
        cause: new AggregateError(
          [operationError, cleanupError],
          "Codex control operation and cleanup both failed.",
        ),
      },
    );
  }
  if (!installationUse?.release({ cleanupConfirmed: true })
    && options.installationUse) {
    throw new ProcessTreeTerminationError(
      options.processLabel ?? "Codex control process tree",
    );
  }
  if (operationFailed) throw operationError;
  return operationResult;
}
