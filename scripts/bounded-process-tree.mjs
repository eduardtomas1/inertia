import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const DIAGNOSTIC_TAIL_BYTES = 16 * 1024;
const PROCESS_TREE_DRAIN_TIMEOUT_MS = 1_000;
const PROCESS_TREE_SETTLE_TIMEOUT_MS = 10_000;
const PROCESS_TREE_SETTLE_INTERVAL_MS = 100;
const HANDOFF_MAX_BYTES = 4 * 1024;
const WINDOWS_GUARDIAN_READY_TIMEOUT_MS = 15_000;
const WINDOWS_GUARDIAN_MAX_BYTES = 1024 * 1024;
const OWNER_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function trustedWindowsGuardian(options) {
  if (process.platform !== "win32") return null;
  const path =
    options.windowsJobGuardian?.path ??
    resolve(
      import.meta.dirname,
      "..",
      "resources",
      "generated",
      "runtime-process-guardian",
      "windows-runtime-job.exe",
    );
  const integrityPath =
    options.windowsJobGuardian?.integrityPath ??
    resolve(
      import.meta.dirname,
      "..",
      "resources",
      "generated",
      "windows-runtime-job-integrity.json",
    );
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  const integrityMetadata = lstatSync(integrityPath, { throwIfNoEntry: false });
  const integrity = JSON.parse(readFileSync(integrityPath, "utf8"));
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > WINDOWS_GUARDIAN_MAX_BYTES ||
    !integrityMetadata ||
    integrityMetadata.isSymbolicLink() ||
    !integrityMetadata.isFile() ||
    integrityMetadata.size <= 0 ||
    integrityMetadata.size > 4_096 ||
    !integrity ||
    typeof integrity !== "object" ||
    Object.keys(integrity).length !== 1 ||
    !/^[0-9a-f]{64}$/u.test(integrity?.sha256 ?? "")
  )
    throw new Error("The bounded Windows process guardian is invalid.");
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== integrity.sha256) {
    throw new Error(
      "The bounded Windows process guardian failed integrity validation.",
    );
  }
  const testTimeout = (name, fallback) =>
    process.env.NODE_ENV === "test" &&
    Number.isSafeInteger(options.windowsJobGuardian?.[name]) &&
    options.windowsJobGuardian[name] > 0
      ? options.windowsJobGuardian[name]
      : fallback;
  return {
    cleanupTimeoutMs: testTimeout(
      "cleanupTimeoutMs",
      PROCESS_TREE_SETTLE_TIMEOUT_MS,
    ),
    path,
    readyTimeoutMs: testTimeout(
      "readyTimeoutMs",
      WINDOWS_GUARDIAN_READY_TIMEOUT_MS,
    ),
    sha256: integrity.sha256,
  };
}

async function launchWindowsGuardian(
  child,
  launchedAt,
  authority,
  environment,
  appendDiagnostic,
) {
  const jobName = `Global\\InertiaBounded-${randomUUID()}`;
  const guardian = spawn(
    authority.path,
    [
      "guard-owned",
      jobName,
      String(child.pid),
      String(process.pid),
      String(launchedAt - 1_000),
      authority.sha256,
    ],
    {
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  guardian.stdin.on("error", () => {
    // Guardian completion owns launch/containment failure reporting.
  });
  let readyBuffer = "";
  let signalReady;
  const ready = new Promise((settle) => {
    signalReady = settle;
  });
  guardian.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    readyBuffer = `${readyBuffer}${text}`.slice(-4_096);
    if (readyBuffer.split(/\r?\n/u).includes("READY")) signalReady(true);
  });
  guardian.stderr.on("data", appendDiagnostic);
  const completion = new Promise((settle) => {
    guardian.once("error", (error) => settle({ error }));
    guardian.once("close", (code, signal) => settle({ code, signal }));
  });
  let timeout;
  const admitted = await Promise.race([
    ready,
    completion.then(() => false),
    new Promise((settle) => {
      timeout = setTimeout(() => settle(false), authority.readyTimeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  if (!admitted) {
    guardian.stdin.end();
    let cleanupConfirmed = await waitForCompletion(
      completion,
      authority.cleanupTimeoutMs,
    );
    if (!cleanupConfirmed) {
      try {
        guardian.kill("SIGKILL");
      } catch {
        // Exact ChildProcess completion below remains authoritative.
      }
      cleanupConfirmed = await waitForCompletion(
        completion,
        authority.cleanupTimeoutMs,
      );
    }
    return { admitted: false, cleanupConfirmed, completion, guardian };
  }
  return { admitted: true, cleanupConfirmed: true, completion, guardian };
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
    process.platform === "win32" ||
    !Number.isSafeInteger(processGroupId) ||
    processGroupId <= 0
  )
    return false;
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
  if (!isAbsolute(path))
    throw new Error("The process-group handoff path must be absolute.");
  const parent = await lstat(dirname(path));
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.uid !== process.geteuid() ||
    (parent.mode & 0o077) !== 0
  )
    throw new Error(
      "The process-group handoff parent must be an owner-private direct directory.",
    );
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
  await writeFile(
    options.path,
    `${JSON.stringify({
      ownerToken: options.ownerToken,
      state: "pending",
    })}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );
}

async function readPosixProcessGroupHandoff(
  options,
  supervisorPid,
  launchedAt,
) {
  if (options === undefined) return { state: "disabled" };
  let metadata;
  try {
    metadata = await lstat(options.path);
  } catch (error) {
    if (error?.code === "ENOENT")
      return { state: "invalid", reason: "missing" };
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.uid !== process.geteuid() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > HANDOFF_MAX_BYTES
  )
    return { state: "invalid", reason: "unsafe-file" };
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
    (value.state !== "launching" &&
      value.state !== "owned" &&
      value.state !== "released") ||
    value.supervisorPid !== supervisorPid ||
    !Number.isSafeInteger(value.timestampMs) ||
    value.timestampMs < launchedAt ||
    value.timestampMs > Date.now() + 1_000
  )
    return { state: "invalid", reason: "identity" };
  if (value.state === "launching") return { state: "launching" };
  if (
    !Number.isSafeInteger(value.processGroupId) ||
    value.processGroupId <= 0 ||
    value.processGroupId === supervisorPid
  )
    return { state: "invalid", reason: "process-group" };
  return { state: value.state, processGroupId: value.processGroupId };
}

export function posixProcessGroupKillIsConfirmed(error, groupStillExists) {
  return (
    error === null || (error?.code === "ESRCH" && groupStillExists === false)
  );
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

async function terminateProcessTree(child, completion, windowsGuardian) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  let terminationConfirmed = false;
  if (process.platform === "win32") {
    // Until the native Job guardian has admitted the trampoline, the payload
    // has not received GO and therefore cannot have created descendants. Kill
    // only the exact ChildProcess handle; a PID-wide taskkill here could target
    // a reused PID after an unusually fast root exit.
    if (!windowsGuardian?.admitted) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Completion below is the authority for this exact child handle.
      }
      return await waitForCompletion(
        completion,
        PROCESS_TREE_SETTLE_TIMEOUT_MS,
      );
    }
    if (windowsGuardian) {
      windowsGuardian.guardian.stdin.end();
      const guardianResult = await Promise.race([
        windowsGuardian.completion,
        sleep(PROCESS_TREE_SETTLE_TIMEOUT_MS).then(() => null),
      ]);
      const rootStopped = await waitForCompletion(
        completion,
        PROCESS_TREE_SETTLE_TIMEOUT_MS,
      );
      if (
        rootStopped &&
        guardianResult &&
        !guardianResult.error &&
        guardianResult.signal === null &&
        (guardianResult.code === 0 || guardianResult.code === 28)
      )
        return true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Direct root cleanup does not establish descendant-tree settlement.
      }
      await waitForCompletion(completion, PROCESS_TREE_SETTLE_TIMEOUT_MS);
      return false;
    }
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
  const rootStopped = await waitForCompletion(
    completion,
    PROCESS_TREE_SETTLE_TIMEOUT_MS,
  );
  if (!rootStopped) return false;
  return process.platform === "win32"
    ? true
    : await waitForPosixProcessGroupExit(child.pid);
}

export async function runBounded(command, args, options) {
  const environment = options.env ?? process.env;
  if (
    options.windowsVerbatimArguments !== undefined &&
    typeof options.windowsVerbatimArguments !== "boolean"
  ) {
    throw new Error(`${options.label} Windows argument mode is invalid.`);
  }
  if (options.windowsVerbatimArguments === true && process.platform !== "win32") {
    throw new Error(
      `${options.label} requested Windows argument mode on another platform.`,
    );
  }
  const input =
    options.input === undefined
      ? null
      : Buffer.isBuffer(options.input)
        ? options.input
        : Buffer.from(options.input);
  if (input !== null && input.length > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${options.label} input exceeds its limit.`);
  }
  await initializePosixProcessGroupHandoff(options.posixProcessGroupHandoff);
  const windowsAuthority = trustedWindowsGuardian(options);
  const launchedAt = Date.now();
  const useAdmissionTrampoline =
    windowsAuthority !== null || typeof options.onSpawn === "function";
  const trampolinePayload = useAdmissionTrampoline
    ? Buffer.from(
        JSON.stringify({
          args,
          command,
          input: input === null ? null : input.toString("base64"),
          windowsVerbatimArguments: options.windowsVerbatimArguments,
        }),
      ).toString("base64")
    : null;
  const child = spawn(
    useAdmissionTrampoline ? process.execPath : command,
    useAdmissionTrampoline
      ? [
          join(import.meta.dirname, "bounded-command-trampoline.mjs"),
          trampolinePayload,
        ]
      : args,
    {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: [
        useAdmissionTrampoline || input !== null ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
      windowsHide: true,
    },
  );
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
    if (options.echoOutputLive) {
      (chunks === stdoutChunks ? process.stdout : process.stderr).write(buffer);
    }
    if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) signalOverflow();
  };
  child.stdout?.on("data", (chunk) => appendOutput(stdoutChunks, chunk));
  child.stderr?.on("data", (chunk) => appendOutput(stderrChunks, chunk));
  const completion = new Promise((settle) => {
    child.once("error", (error) => settle({ error }));
    child.once("close", (code, signal) => settle({ code, signal }));
  });
  try {
    options.onSpawn?.({
      pid: child.pid,
      processGroupId: process.platform === "win32" ? null : child.pid,
    });
  } catch (error) {
    const stopped = await terminateProcessTree(child, completion, null);
    if (!stopped) {
      throw new ProcessTreeCleanupError(
        `${options.label} child ownership registration failed and its process tree could not be confirmed stopped.`,
      );
    }
    throw error;
  }
  let windowsGuardian = null;
  if (windowsAuthority) {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new ProcessTreeCleanupError(
        `${options.label} could not establish a Windows process-tree root.`,
      );
    }
    windowsGuardian = await launchWindowsGuardian(
      child,
      launchedAt,
      windowsAuthority,
      environment,
      (chunk) => appendOutput(stderrChunks, chunk),
    );
    if (!windowsGuardian.admitted) {
      const stopped = await terminateProcessTree(
        child,
        completion,
        windowsGuardian,
      );
      if (!stopped || !windowsGuardian.cleanupConfirmed) {
        throw new ProcessTreeCleanupError(
          `${options.label} could not establish or clean its Windows Job authority.\n${outputTail}`,
        );
      }
      throw new Error(
        `${options.label} could not establish its Windows Job authority.\n${outputTail}`,
      );
    }
  }
  if (useAdmissionTrampoline) {
    child.stdin?.on("error", () => {
      // Early trampoline exit is reported through owned child completion.
    });
    child.stdin?.end("GO\n");
  } else if (input !== null) {
    child.stdin?.on("error", () => {
      // Early command exit is reported through the owned child completion.
    });
    child.stdin?.end(input);
  }
  let timeoutTimer;
  let removeAbortListener = () => {};
  const aborted = new Promise((settle) => {
    if (!options.signal) return;
    if (options.signal.aborted) {
      settle({ kind: "aborted" });
      return;
    }
    const onAbort = () => settle({ kind: "aborted" });
    options.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      options.signal.removeEventListener("abort", onAbort);
  });
  const outcome = await Promise.race([
    completion.then((result) => ({ kind: "completed", result })),
    overflowed.then(() => ({ kind: "overflow" })),
    aborted,
    new Promise((settle) => {
      timeoutTimer = setTimeout(
        () => settle({ kind: "timeout" }),
        options.timeoutMs,
      );
    }),
  ]);
  clearTimeout(timeoutTimer);
  removeAbortListener();
  if (outcome.kind !== "completed") {
    const treeStopped = await terminateProcessTree(
      child,
      completion,
      windowsGuardian,
    );
    const handoff = await readPosixProcessGroupHandoff(
      options.posixProcessGroupHandoff,
      child.pid,
      launchedAt,
    );
    const handedOffTreeStopped =
      handoff.state === "disabled" || handoff.state === "pending"
        ? true
        : handoff.state === "owned"
          ? await terminatePosixProcessGroup(handoff.processGroupId)
          : handoff.state === "released"
            ? !posixProcessGroupExists(handoff.processGroupId)
            : false;
    const reason =
      outcome.kind === "timeout"
        ? "timed out"
        : outcome.kind === "aborted"
          ? "was aborted"
          : "exceeded its output limit";
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
  if (windowsGuardian) {
    const guardianResult = await Promise.race([
      windowsGuardian.completion,
      sleep(PROCESS_TREE_SETTLE_TIMEOUT_MS).then(() => null),
    ]);
    if (!guardianResult) {
      const treeStopped = await terminateProcessTree(
        child,
        completion,
        windowsGuardian,
      );
      if (!treeStopped) {
        throw new ProcessTreeCleanupError(
          `${options.label} exited, but its Windows Job authority did not settle.\n${outputTail}`,
        );
      }
      throw new Error(
        `${options.label} exited, but its Windows Job authority timed out and was terminated.\n${outputTail}`,
      );
    }
    if (
      guardianResult.error ||
      guardianResult.signal !== null ||
      (guardianResult.code !== 0 && guardianResult.code !== 28)
    ) {
      throw new ProcessTreeCleanupError(
        `${options.label} exited with a failed Windows Job authority.\n${outputTail}`,
      );
    }
    removedResidualProcessTree = guardianResult.code === 28;
  }
  if (posixProcessGroupExists(child.pid)) {
    const drained = await waitForPosixProcessGroupExit(
      child.pid,
      PROCESS_TREE_DRAIN_TIMEOUT_MS,
    );
    if (!drained) {
      const treeStopped = await terminateProcessTree(
        child,
        completion,
        windowsGuardian,
      );
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
  const commandSucceeded =
    !outcome.result.error &&
    outcome.result.code === 0 &&
    outcome.result.signal === null;
  if (
    handoff.state === "released" &&
    posixProcessGroupExists(handoff.processGroupId)
  ) {
    throw new ProcessTreeCleanupError(
      `${options.label} exited, but its released process-group id is live and no longer safe to terminate.\n${outputTail}`,
    );
  }
  if (
    handoff.state === "owned" &&
    posixProcessGroupExists(handoff.processGroupId) &&
    !commandSucceeded
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
    throw new Error(
      `${options.label} failed to start: ${outcome.result.error.message}\n${outputTail}`,
    );
  }
  if (outcome.result.code !== 0 || outcome.result.signal !== null) {
    const exit =
      outcome.result.code === null
        ? `signal ${String(outcome.result.signal)}`
        : `status ${String(outcome.result.code)}`;
    throw new Error(`${options.label} exited with ${exit}.\n${outputTail}`);
  }
  if (
    options.posixProcessGroupHandoff !== undefined &&
    handoff.state !== "released"
  ) {
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
  if (options.echoOutput && !options.echoOutputLive) {
    if (stdout.length > 0) process.stdout.write(stdout);
    if (stderr.length > 0) process.stderr.write(stderr);
  }
  return stdout;
}
