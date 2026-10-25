import { connect } from "node:net";

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

export interface FixtureProcessIdentity {
  pid: number;
  endpoint?: string | null;
}

const ENDPOINT_GONE = new Set(["ENOENT", "ECONNREFUSED"]);

export async function fixtureProcessExists(
  identity: FixtureProcessIdentity,
): Promise<boolean> {
  const { endpoint } = identity;
  if (!endpoint) return executableProcessExists(identity.pid);
  return await new Promise<boolean>((resolve) => {
    const socket = connect(endpoint);
    const settle = (alive: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => settle(true), 2_000);
    socket.once("connect", () => settle(true));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      settle(!ENDPOINT_GONE.has(error.code ?? "")));
  });
}
