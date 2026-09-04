import { spawn } from "node:child_process";
import { join } from "node:path";

import { runBounded } from "./bounded-process-tree.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

export function processIsTerminal(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function confirmProviderProcessTermination(
  child,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
) {
  if (processIsTerminal(child)) return true;
  let timer;
  const onError = () => settleCompletion(processIsTerminal(child));
  const onClose = () => settleCompletion(true);
  let settleCompletion;
  const completion = new Promise((resolve) => {
    settleCompletion = resolve;
    child.once("error", onError);
    child.once("close", onClose);
  });
  const removeListeners = () => {
    child.off("error", onError);
    child.off("close", onClose);
  };
  if (processIsTerminal(child)) {
    removeListeners();
    return true;
  }
  try {
    child.kill("SIGKILL");
  } catch {
    removeListeners();
    return processIsTerminal(child);
  }
  if (processIsTerminal(child)) {
    removeListeners();
    return true;
  }
  const confirmed = await Promise.race([
    completion,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(processIsTerminal(child)), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  removeListeners();
  return confirmed;
}

function validInitializeEnvelope(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
  const hasError = Object.prototype.hasOwnProperty.call(message, "error");
  if (message.jsonrpc !== "2.0" || message.id !== 1 || hasResult === hasError
    || Object.prototype.hasOwnProperty.call(message, "method")) return false;
  if (!hasError) return true;
  return message.error
    && typeof message.error === "object"
    && !Array.isArray(message.error)
    && Number.isInteger(message.error.code)
    && typeof message.error.message === "string";
}

function validateInitializeResult(initialized, validation) {
  if (!initialized || typeof initialized !== "object" || Array.isArray(initialized)
    || initialized.protocolVersion !== 1) {
    throw new Error(`${validation.expectedAgent} ACP initialize response is incompatible.`);
  }
  const capabilities = initialized.agentCapabilities;
  if (capabilities !== undefined && (
    !capabilities
    || typeof capabilities !== "object"
    || Array.isArray(capabilities)
  )) throw new Error(`${validation.expectedAgent} ACP initialize response is incompatible.`);
  const sessionResume = capabilities?.sessionCapabilities?.resume;
  const hasSessionResumeCapability = validation.allowSessionCapabilitiesResume === true
    && sessionResume
    && typeof sessionResume === "object"
    && !Array.isArray(sessionResume);
  if (validation.requireLoadSession
    && capabilities?.loadSession !== true
    && !hasSessionResumeCapability) {
    throw new Error(`${validation.expectedAgent} ACP does not advertise session resume support.`);
  }
  const agentInfo = initialized.agentInfo;
  // ACP v1 permits omitted/null implementation metadata. Cursor's official
  // CLI currently omits it; keep present identities strict and opt in per probe.
  if (validation.allowMissingAgentInfo === true
    && (agentInfo === undefined || agentInfo === null)) return;
  if (!agentInfo || typeof agentInfo !== "object"
    || Array.isArray(agentInfo)
    || typeof agentInfo.name !== "string"
    || typeof agentInfo.version !== "string"
    || agentInfo.name !== validation.expectedAgent
  ) throw new Error(`${validation.expectedAgent} ACP initialize response is incompatible.`);
}

export async function runAcpInitializeHandshake(
  command,
  args,
  options,
  validation,
  dependencies = {},
) {
  const spawnImplementation = dependencies.spawn ?? spawn;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs
    ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const maxOutputChars = dependencies.maxOutputChars
    ?? DEFAULT_MAX_OUTPUT_CHARS;
  const child = spawnImplementation(command, args, {
    cwd: options.cwd,
    detached: false,
    env: options.environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let handshakeError;
  child.stderr.resume();
  try {
    const initialized = await new Promise((resolveHandshake, rejectHandshake) => {
      let output = "";
      let settled = false;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("error", onChildError);
        child.removeListener("exit", onEarlyExit);
        child.stdout.removeListener("data", onOutput);
        action();
      };
      const fail = (error) => finish(() => rejectHandshake(error));
      const onChildError = (error) => fail(error);
      const onEarlyExit = (code, signal) => fail(new Error(
        `${validation.expectedAgent} ACP exited during initialize (${code ?? signal ?? "unknown"}).`,
      ));
      const onOutput = (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > maxOutputChars) {
          fail(new Error(`${validation.expectedAgent} ACP initialize output exceeded the limit.`));
          return;
        }
        while (output.includes("\n")) {
          const newline = output.indexOf("\n");
          const line = output.slice(0, newline).trim();
          output = output.slice(newline + 1);
          if (!line) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            fail(new Error(`${validation.expectedAgent} ACP returned malformed JSON.`));
            return;
          }
          if (!message || typeof message !== "object" || Array.isArray(message)) {
            fail(new Error(`${validation.expectedAgent} ACP returned an invalid JSON-RPC message.`));
            return;
          }
          if (!Object.prototype.hasOwnProperty.call(message, "id")) {
            const validNotification = message.jsonrpc === "2.0"
              && typeof message.method === "string"
              && !Object.prototype.hasOwnProperty.call(message, "result")
              && !Object.prototype.hasOwnProperty.call(message, "error");
            if (!validNotification) {
              fail(new Error(`${validation.expectedAgent} ACP returned an invalid JSON-RPC message.`));
              return;
            }
            continue;
          }
          if (!validInitializeEnvelope(message)) {
            fail(new Error(`${validation.expectedAgent} ACP returned an invalid JSON-RPC response.`));
            return;
          }
          if (Object.prototype.hasOwnProperty.call(message, "error")) {
            fail(new Error(`${validation.expectedAgent} ACP rejected initialize.`));
          } else {
            finish(() => resolveHandshake(message.result));
          }
          return;
        }
      };
      const timer = setTimeout(
        () => fail(new Error(`${validation.expectedAgent} ACP initialize timed out.`)),
        timeoutMs,
      );
      timer.unref();
      child.once("error", onChildError);
      child.once("exit", onEarlyExit);
      child.stdout.on("data", onOutput);
      // Keep a listener installed until process cleanup: a peer can close its
      // read end after the write callback but before termination begins.
      child.stdin.on("error", fail);
      try {
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: validation.advertiseCompaction === false
              ? { plan: {} }
              : { plan: {}, session: { compaction: {} } },
            clientInfo: { name: "Inertia provider drift", version: "1.0.0" },
          },
        })}\n`, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error);
      }
    });
    validateInitializeResult(initialized, validation);
  } catch (error) {
    handshakeError = error;
  }
  child.stdin.destroy();
  const cleanupConfirmed = await confirmProviderProcessTermination(
    child,
    cleanupTimeoutMs,
  );
  if (!cleanupConfirmed) {
    throw new AggregateError(
      handshakeError ? [handshakeError] : [],
      `${validation.expectedAgent} ACP cleanup could not be confirmed.`,
    );
  }
  if (handshakeError) throw handshakeError;
}

export async function requireAcpInitializeHandshake(
  command,
  args,
  options,
  validation,
  dependencies = {},
) {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs
    ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const maxOutputChars = dependencies.maxOutputChars
    ?? DEFAULT_MAX_OUTPUT_CHARS;
  const payload = Buffer.from(JSON.stringify({
    args,
    command,
    validation,
  }), "utf8").toString("base64");
  await runBounded(
    process.execPath,
    [join(import.meta.dirname, "provider-drift-acp-runtime.mjs"), payload],
    {
      cwd: options.cwd,
      env: options.environment,
      label: `${validation.expectedAgent} ACP initialize probe`,
      maxOutputBytes: maxOutputChars,
      onSpawn: ({ pid, processGroupId }) => {
        if (!Number.isSafeInteger(pid) || pid <= 1
          || (process.platform !== "win32" && processGroupId !== pid)) {
          throw new Error(`${validation.expectedAgent} ACP ownership admission failed.`);
        }
      },
      timeoutMs: timeoutMs + cleanupTimeoutMs + 1_000,
    },
  );
}
