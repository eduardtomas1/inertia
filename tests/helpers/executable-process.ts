import { linuxProcessCanExecute } from
  "../../src/node/runtime-owned-process-posix";

/**
 * Reports whether a test-owned PID can still execute.
 *
 * Linux zombies remain signal-visible until an external subreaper collects
 * them. Unknown /proc observations deliberately fall back to the conservative
 * signal probe.
 */
export function executableProcessExists(pid: number): boolean {
  if (process.platform === "linux") {
    const executable = linuxProcessCanExecute(pid);
    if (executable !== null) return executable;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error !== null
      && typeof error === "object"
      && "code" in error
      && error.code === "EPERM";
  }
}
