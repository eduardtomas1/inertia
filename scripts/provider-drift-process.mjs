import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

export function processIsTerminal(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function terminateProviderProcess(child) {
  if (!child.pid || processIsTerminal(child)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may have exited between the checks.
    }
  }
}

export async function confirmProviderProcessTermination(
  child,
  terminate = terminateProviderProcess,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
) {
  if (processIsTerminal(child)) return true;
  return await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onTerminal);
      child.removeListener("close", onTerminal);
      resolve(confirmed);
    };
    const onTerminal = () => finish(true);
    child.once("exit", onTerminal);
    child.once("close", onTerminal);
    timer = setTimeout(() => finish(processIsTerminal(child)), timeoutMs);
    timer.unref();
    if (processIsTerminal(child)) {
      finish(true);
      return;
    }
    try {
      terminate(child);
    } catch {
      finish(processIsTerminal(child));
      return;
    }
    if (processIsTerminal(child)) finish(true);
  });
}

export async function requireAcpInitializeHandshake(
  command,
  args,
  options,
  expectedAgent,
  dependencies = {},
) {
  const spawnImplementation = dependencies.spawn ?? spawn;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cleanupTimeoutMs = dependencies.cleanupTimeoutMs
    ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const maxOutputChars = dependencies.maxOutputChars
    ?? DEFAULT_MAX_OUTPUT_CHARS;
  const terminate = dependencies.terminate ?? terminateProviderProcess;
  const child = spawnImplementation(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
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
        `${expectedAgent} ACP exited during initialize (${code ?? signal ?? "unknown"}).`,
      ));
      const onOutput = (chunk) => {
        output += chunk.toString("utf8");
        if (output.length > maxOutputChars) {
          fail(new Error(`${expectedAgent} ACP initialize output exceeded the limit.`));
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
            fail(new Error(`${expectedAgent} ACP returned malformed JSON.`));
            return;
          }
          if (message?.id !== 1) continue;
          if (message.error) {
            fail(new Error(`${expectedAgent} ACP rejected initialize.`));
          } else {
            finish(() => resolveHandshake(message.result));
          }
          return;
        }
      };
      const timer = setTimeout(
        () => fail(new Error(`${expectedAgent} ACP initialize timed out.`)),
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
            clientCapabilities: { plan: {}, session: { compaction: {} } },
            clientInfo: { name: "Inertia provider drift", version: "1.0.0" },
          },
        })}\n`, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error);
      }
    });
    const agentName = initialized?.agentInfo?.name;
    const capabilities = initialized?.agentCapabilities;
    if (initialized?.protocolVersion !== 1
      || !capabilities
      || typeof capabilities !== "object"
      || Array.isArray(capabilities)
      || (agentName !== undefined
        && (typeof agentName !== "string" || !expectedAgent.test(agentName)))) {
      throw new Error(`${expectedAgent} ACP initialize response is incompatible.`);
    }
  } catch (error) {
    handshakeError = error;
  }
  child.stdin.destroy();
  const cleanupConfirmed = await confirmProviderProcessTermination(
    child,
    terminate,
    cleanupTimeoutMs,
  );
  if (!cleanupConfirmed) {
    throw new AggregateError(
      handshakeError ? [handshakeError] : [],
      `${expectedAgent} ACP cleanup could not be confirmed.`,
    );
  }
  if (handshakeError) throw handshakeError;
}
