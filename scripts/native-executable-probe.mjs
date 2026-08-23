import { spawn, spawnSync } from "node:child_process";
import { win32 } from "node:path";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 2_000;

function inheritedWindowsSystemRoot(environment = process.env) {
  const entry = Object.entries(environment).find(([name]) =>
    ["systemroot", "windir"].includes(name.toLowerCase()));
  const candidate = entry?.[1]?.trim();
  return candidate && win32.isAbsolute(candidate) ? win32.normalize(candidate) : null;
}

function forceTerminateProcessTree(child) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") {
    const systemRoot = inheritedWindowsSystemRoot();
    if (systemRoot) {
      try {
        const result = spawnSync(
          win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/pid", String(pid), "/t", "/f"],
          {
            env: { SystemRoot: systemRoot },
            shell: false,
            stdio: "ignore",
            timeout: CLEANUP_TIMEOUT_MS,
            windowsHide: true,
          },
        );
        if (!result.error && result.status === 0) return true;
      } catch {
        // The direct-child fallback below is intentionally not confirmation
        // that taskkill stopped every descendant.
      }
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      // The process group may already have exited or failed to form.
    }
  }
  try { child.kill("SIGKILL"); } catch { /* The direct child may already be gone. */ }
  return false;
}

export function probeNativeExecutable(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(command, args, {
      detached: process.platform !== "win32",
      env: options.environment ?? {},
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure;
    let settled = false;
    let cleanupTimer;
    let deadlineTimer;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(cleanupTimer);
      callback();
    };
    const stopTree = (error) => {
      if (failure || settled) return;
      failure = error;
      clearTimeout(deadlineTimer);
      const treeTerminationConfirmed = forceTerminateProcessTree(child);
      if (!treeTerminationConfirmed) {
        failure = new Error(`${error.message} The provider process tree could not be confirmed stopped.`);
      }
      cleanupTimer = setTimeout(() => {
        settle(() => rejectProbe(new Error(
          `${failure.message} The provider process did not close within the cleanup deadline.`,
        )));
      }, CLEANUP_TIMEOUT_MS);
    };
    const capture = (stream) => (chunk) => {
      if (failure || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const previousOutputBytes = outputBytes;
      outputBytes += buffer.length;
      const remaining = Math.max(0, outputLimit - previousOutputBytes);
      if (remaining > 0) {
        const text = buffer.subarray(0, remaining).toString("utf8");
        if (stream === "stdout") stdout += text;
        else stderr += text;
      }
      if (outputBytes > outputLimit) {
        stopTree(new Error(`The native executable exceeded its ${outputLimit} byte output limit.`));
      }
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));
    child.once("error", (error) => settle(() => rejectProbe(error)));
    child.once("close", (status, signal) => {
      if (failure) {
        settle(() => rejectProbe(failure));
        return;
      }
      settle(() => resolveProbe({ signal, status, stderr, stdout }));
    });
    deadlineTimer = setTimeout(() => {
      stopTree(new Error(`The native executable exceeded its ${timeoutMs}ms deadline.`));
    }, timeoutMs);
  });
}
