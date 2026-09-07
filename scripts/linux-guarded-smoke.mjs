import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { linuxProcessGroupCanExecute } from "./linux-process-group.mjs";

// The native subreaper owns the whole smoke, including AppImage wrappers and
// update candidates that create new sessions/process groups before readiness.
export async function runLinuxGuardedSmoke({ guardian, command, args, env = process.env, timeoutMs = 180_000 }) {
  const executable = statSync(guardian, { bigint: true });
  const device = String(executable.dev);
  const inode = String(executable.ino);
  const child = spawn(guardian, ["watch", String(process.pid), device, inode, "--", command, ...args], {
    shell: false, detached: true, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output = (output + chunk.toString("utf8")).slice(-64 * 1024);
  });
  let outcome = null;
  child.once("error", (error) => { outcome = { error }; });
  child.once("exit", (code, signal) => { outcome = { code, signal }; });
  const helper = (args) => spawnSync(guardian, args, {
    shell: false, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8",
    maxBuffer: 4_096, timeout: 5_000, killSignal: "SIGKILL",
  });
  const successful = (result) => !result.error && result.status === 0 && !result.signal && result.stderr === "";
  const status = () => {
    try { return readFileSync(`/proc/${child.pid}/status`, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  };
  const wait = async (label, predicate, duration) => {
    const deadline = Date.now() + duration;
    do {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    throw new Error(`${label} timed out.`);
  };
  let identity;
  let admitted = false;
  let terminalProved = false;
  let failure;
  let cleanupFailure;
  try {
    await wait("Smoke guardian readiness", () => outcome || status().includes("Name:\tinertia-ready\n"), 5_000);
    if (outcome) throw new Error("The smoke guardian exited before admission.");
    const ready = helper(["ready", String(child.pid)]);
    const fields = ready.stdout.trim().split("|");
    if (!successful(ready) || fields.length !== 6 || fields.some((value) => !/^[1-9][0-9]*$/u.test(value))
      || fields[0] !== String(child.pid) || fields[1] !== String(process.pid)
      || fields[2] !== String(child.pid) || fields[4] !== device || fields[5] !== inode) {
      throw new Error("The smoke guardian identity is invalid.");
    }
    identity = fields;
    for (const action of ["claim", "exec"]) {
      if (!successful(helper(["signal", fields[0], fields[3], device, inode, action]))) {
        throw new Error(`The smoke guardian ${action} was rejected.`);
      }
      // A claimed guardian uses authenticated terminal cleanup even when the
      // subsequent exec authorization fails before the payload is released.
      admitted = true;
    }
    await wait("Installed smoke", () => outcome || /Name:\tinertia-(?:exdone|done|bad)\n/u.test(status()), timeoutMs);
  } catch (error) { failure = error; }
  finally {
    if (child.pid && !outcome) {
      if (admitted && identity) {
        if (!/Name:\tinertia-(?:exdone|done)\n/u.test(status())) {
          helper(["signal", identity[0], identity[3], device, inode, "stop"]);
        }
        try {
          await wait("Smoke descendant drain", () => {
            const value = status();
            return outcome || /Name:\tinertia-(?:exdone|done)\n/u.test(value) && /State:\tT/u.test(value);
          }, 10_000);
          if (!outcome) {
            // Require the same hardened, child-free stopped state as runtime
            // recovery, then release via the exact pidfd/start-bound helper.
            // A normal release preserves the payload's exit code (recovery's
            // SIGKILL would erase that result).
            const terminal = status();
            const childFree = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8") === "";
            terminalProved = childFree
              && /Name:\tinertia-(?:exdone|done)\n/u.test(terminal)
              && /State:\tT/u.test(terminal)
              && ["TracerPid:\t0\n", "Threads:\t1\n", "NoNewPrivs:\t1\n", "Seccomp:\t2\n"].every((field) => terminal.includes(field))
              && successful(helper(["signal", identity[0], identity[3], device, inode, "release"]));
          }
        } catch (error) { failure ??= error; }
      } else {
        terminalProved = successful(helper(["stop-pending", String(child.pid), String(process.pid), device, inode]));
      }
    }
    try { await wait("Smoke guardian exit", () => outcome !== null, 5_000); }
    catch (error) { failure ??= error; }
    child.stdout.destroy();
    child.stderr.destroy();
    if (!terminalProved || !outcome || outcome.error || outcome.signal
      || linuxProcessGroupCanExecute(child.pid) !== false) {
      const error = new Error(`The installed smoke process tree cleanup is unconfirmed.\n${output}`);
      error.preserveTemporaryRoot = true;
      cleanupFailure = error;
    }
  }
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw new Error(`${failure.message}\n${output}`, { cause: failure });
  if (outcome.code !== 0) throw new Error(`Installed smoke exited with status ${outcome.code}.\n${output}`);
  return output;
}
