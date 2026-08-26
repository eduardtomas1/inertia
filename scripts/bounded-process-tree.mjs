import { spawn, spawnSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, win32 } from "node:path";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const DIAGNOSTIC_TAIL_BYTES = 16 * 1024;
const PROCESS_TREE_DRAIN_TIMEOUT_MS = 1_000;
const PROCESS_TREE_SETTLE_TIMEOUT_MS = 10_000;
const PROCESS_TREE_SETTLE_INTERVAL_MS = 100;
const TASKKILL_TIMEOUT_MS = 10_000;
const HANDOFF_MAX_BYTES = 4 * 1024;
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class ProcessTreeCleanupError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProcessTreeCleanupError";
    this.preserveTemporaryRoot = true;
  }
}

function sleep(milliseconds) {
  return new Promise((settle) => setTimeout(settle, milliseconds));
}

function trustedTaskkillPath(environment) {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) {
    throw new Error("The trusted Windows system root is unavailable.");
  }
  return win32.join(systemRoot, "System32", "taskkill.exe");
}

async function waitForCompletion(completion, timeoutMs) {
  let settleTimer;
  const settled = await Promise.race([
    completion.then(() => true),
    new Promise((settle) => {
      settleTimer = setTimeout(() => settle(false), timeoutMs);
    }),
  ]);
  clearTimeout(settleTimer);
  return settled;
}

async function waitForPosixProcessGroupExit(
  processGroupId,
  timeoutMs = PROCESS_TREE_SETTLE_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      if (error?.code === "EPERM") {
        await sleep(PROCESS_TREE_SETTLE_INTERVAL_MS);
        continue;
      }
      throw error;
    }
    await sleep(PROCESS_TREE_SETTLE_INTERVAL_MS);
  }
  return false;
}

function posixProcessGroupExists(processGroupId) {
  if (
    process.platform === "win32"
    || !Number.isSafeInteger(processGroupId)
    || processGroupId <= 0
  ) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function validateHandoffParent(path) {
  if (!isAbsolute(path)) throw new Error("The process-group handoff path must be absolute.");
  const parent = await lstat(dirname(path));
  if (
    parent.isSymbolicLink()
    || !parent.isDirectory()
    || parent.uid !== process.geteuid()
    || (parent.mode & 0o077) !== 0
  ) throw new Error("The process-group handoff parent must be an owner-private direct directory.");
}

async function initializePosixProcessGroupHandoff(options) {
  if (options === undefined) return;
  if (process.platform === "win32") {
    throw new Error("POSIX process-group handoff cannot be used on Windows.");
  }
  if (!OWNER_TOKEN_PATTERN.test(options.ownerToken)) {
    throw new Error("The process-group handoff owner token is invalid.");
  }
  await validateHandoffParent(options.path);
  await writeFile(options.path, `${JSON.stringify({
    ownerToken: options.ownerToken,
    state: "pending",
  })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

async function readPosixProcessGroupHandoff(options, supervisorPid, launchedAt) {
  if (options === undefined) return { state: "disabled" };
  let metadata;
  try {
    metadata = await lstat(options.path);
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "invalid", reason: "missing" };
    throw error;
  }
  if (
    metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.uid !== process.geteuid()
    || (metadata.mode & 0o077) !== 0
    || metadata.size > HANDOFF_MAX_BYTES
  ) return { state: "invalid", reason: "unsafe-file" };
  let value;
  try {
    value = JSON.parse(await readFile(options.path, "utf8"));
  } catch {
    return { state: "invalid", reason: "malformed" };
  }
  if (value?.ownerToken !== options.ownerToken) {
    return { state: "invalid", reason: "owner-token" };
  }
  if (value.state === "pending") return { state: "pending" };
  if (
    (value.state !== "launching" && value.state !== "owned" && value.state !== "released")
    || value.supervisorPid !== supervisorPid
    || !Number.isSafeInteger(value.timestampMs)
    || value.timestampMs < launchedAt
    || value.timestampMs > Date.now() + 1_000
  ) return { state: "invalid", reason: "identity" };
  if (value.state === "launching") return { state: "launching" };
  if (
    !Number.isSafeInteger(value.processGroupId)
    || value.processGroupId <= 0
    || value.processGroupId === supervisorPid
  ) return { state: "invalid", reason: "process-group" };
  return { state: value.state, processGroupId: value.processGroupId };
}

export function posixProcessGroupKillIsConfirmed(error, groupStillExists) {
  return error === null || (error?.code === "ESRCH" && groupStillExists === false);
}

async function terminatePosixProcessGroup(processGroupId) {
  let killError = null;
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    killError = error;
  }
  const terminationConfirmed = posixProcessGroupKillIsConfirmed(
    killError,
    posixProcessGroupExists(processGroupId),
  );
  if (!terminationConfirmed) return false;
  return await waitForPosixProcessGroupExit(processGroupId);
}

async function terminateProcessTree(child, completion, environment) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  let terminationConfirmed = false;
  if (process.platform === "win32") {
    let taskkill;
    try {
      taskkill = spawnSync(
        trustedTaskkillPath(environment),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          encoding: "utf8",
          maxBuffer: 256 * 1024,
          timeout: TASKKILL_TIMEOUT_MS,
          windowsHide: true,
        },
      );
    } catch {
      taskkill = null;
    }
    terminationConfirmed = taskkill?.status === 0 && !taskkill.error;
  } else {
    terminationConfirmed = await terminatePosixProcessGroup(child.pid);
  }
  if (!terminationConfirmed) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Direct termination is cleanup only; it cannot confirm the descendant tree.
    }
    await waitForCompletion(completion, PROCESS_TREE_SETTLE_TIMEOUT_MS);
    return false;
  }
  const rootStopped = await waitForCompletion(completion, PROCESS_TREE_SETTLE_TIMEOUT_MS);
  if (!rootStopped) return false;
  return process.platform === "win32"
    ? true
    : await waitForPosixProcessGroupExit(child.pid);
}

export async function runBounded(command, args, options) {
  const environment = options.env ?? process.env;
  const input = options.input === undefined
    ? null
    : Buffer.isBuffer(options.input) ? options.input : Buffer.from(options.input);
  if (input !== null && input.length > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${options.label} input exceeds its limit.`);
  }
  await initializePosixProcessGroupHandoff(options.posixProcessGroupHandoff);
  const launchedAt = Date.now();
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: environment,
    shell: false,
    stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let outputBytes = 0;
  const stdoutChunks = [];
  const stderrChunks = [];
  let outputTail = "";
  let signalOverflow;
  const overflowed = new Promise((resolveOverflow) => {
    signalOverflow = resolveOverflow;
  });
  const appendOutput = (chunks, chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = Math.max(0, MAX_COMMAND_OUTPUT_BYTES - outputBytes);
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
    outputBytes += buffer.length;
    const text = buffer.toString("utf8");
    outputTail = `${outputTail}${text}`.slice(-DIAGNOSTIC_TAIL_BYTES);
    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) signalOverflow();
  };
  child.stdout?.on("data", (chunk) => appendOutput(stdoutChunks, chunk));
  child.stderr?.on("data", (chunk) => appendOutput(stderrChunks, chunk));
  const completion = new Promise((settle) => {
    child.once("error", (error) => settle({ error }));
    child.once("close", (code, signal) => settle({ code, signal }));
  });
  if (input !== null) {
    child.stdin?.on("error", () => {
      // Early command exit is reported through the owned child completion.
    });
    child.stdin?.end(input);
  }
  let timeoutTimer;
  const outcome = await Promise.race([
    completion.then((result) => ({ kind: "completed", result })),
    overflowed.then(() => ({ kind: "overflow" })),
    new Promise((settle) => {
      timeoutTimer = setTimeout(() => settle({ kind: "timeout" }), options.timeoutMs);
    }),
  ]);
  clearTimeout(timeoutTimer);
  if (outcome.kind !== "completed") {
    const treeStopped = await terminateProcessTree(child, completion, environment);
    const handoff = await readPosixProcessGroupHandoff(
      options.posixProcessGroupHandoff,
      child.pid,
      launchedAt,
    );
    const handedOffTreeStopped = handoff.state === "disabled" || handoff.state === "pending"
      ? true
      : handoff.state === "owned"
        ? await terminatePosixProcessGroup(handoff.processGroupId)
        : handoff.state === "released"
          ? !posixProcessGroupExists(handoff.processGroupId)
        : false;
    const reason = outcome.kind === "timeout" ? "timed out" : "exceeded its output limit";
    if (!treeStopped || !handedOffTreeStopped) {
      throw new ProcessTreeCleanupError(
        `${options.label} ${reason}, and its process tree or handed-off process group could not be confirmed stopped.\n${outputTail}`,
      );
    }
    throw new Error(
      `${options.label} ${reason}; its complete process tree was terminated.\n${outputTail}`,
    );
  }
  let removedResidualProcessTree = false;
  if (posixProcessGroupExists(child.pid)) {
    const drained = await waitForPosixProcessGroupExit(child.pid, PROCESS_TREE_DRAIN_TIMEOUT_MS);
    if (!drained) {
      const treeStopped = await terminateProcessTree(child, completion, environment);
      if (!treeStopped) {
        throw new ProcessTreeCleanupError(
          `${options.label} exited, but its process tree could not be confirmed stopped.\n${outputTail}`,
        );
      }
      removedResidualProcessTree = true;
    }
  }
  const handoff = await readPosixProcessGroupHandoff(
    options.posixProcessGroupHandoff,
    child.pid,
    launchedAt,
  );
  if (handoff.state === "launching" || handoff.state === "invalid") {
    throw new ProcessTreeCleanupError(
      `${options.label} exited with an unconfirmed process-group handoff (${handoff.reason ?? handoff.state}).\n${outputTail}`,
    );
  }
  const commandSucceeded = !outcome.result.error
    && outcome.result.code === 0
    && outcome.result.signal === null;
  if (handoff.state === "released" && posixProcessGroupExists(handoff.processGroupId)) {
    throw new ProcessTreeCleanupError(
      `${options.label} exited, but its released process-group id is live and no longer safe to terminate.\n${outputTail}`,
    );
  }
  if (
    handoff.state === "owned"
    && posixProcessGroupExists(handoff.processGroupId)
    && !commandSucceeded
  ) {
    const drained = await waitForPosixProcessGroupExit(
      handoff.processGroupId,
      PROCESS_TREE_DRAIN_TIMEOUT_MS,
    );
    if (!drained) {
      const stopped = await terminatePosixProcessGroup(handoff.processGroupId);
      if (!stopped) {
        throw new ProcessTreeCleanupError(
          `${options.label} exited, but its handed-off process group could not be confirmed stopped.\n${outputTail}`,
        );
      }
      removedResidualProcessTree = true;
    }
  }
  if (outcome.result.error) {
    throw new Error(`${options.label} failed to start: ${outcome.result.error.message}\n${outputTail}`);
  }
  if (outcome.result.code !== 0 || outcome.result.signal !== null) {
    const exit = outcome.result.code === null
      ? `signal ${String(outcome.result.signal)}`
      : `status ${String(outcome.result.code)}`;
    throw new Error(`${options.label} exited with ${exit}.\n${outputTail}`);
  }
  if (options.posixProcessGroupHandoff !== undefined && handoff.state !== "released") {
    throw new ProcessTreeCleanupError(
      `${options.label} exited successfully without releasing its owned process group.\n${outputTail}`,
    );
  }
  if (removedResidualProcessTree) {
    throw new Error(
      `${options.label} exited successfully but left descendant processes running; its complete process tree was terminated.\n${outputTail}`,
    );
  }
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  if (options.echoOutput) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderr.length > 0) process.stderr.write(stderr);
  }
  return stdout;
}
