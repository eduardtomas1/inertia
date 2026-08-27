import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
interface LinuxProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTimeTicks: string;
  readonly guardianExecutableDevice?: string;
  readonly guardianExecutableInode?: string;
}

export function readLinuxGuardianReady(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
): LinuxProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !isAbsolute(guardianPath)) return null;
  const result = spawnSync(guardianPath, ["ready", String(pid)], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: 1_500, maxBuffer: 4 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal || result.stderr !== "") return null;
  const match = result.stdout.trim().match(/^([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)$/u);
  if (!match) return null;
  const [, rawPid, rawParent, rawGroup, startTimeTicks] = match;
  if (Number(rawPid) !== pid || Number(rawParent) !== expectedParentPid || Number(rawGroup) !== pid) return null;
  try {
    const trusted = statSync(guardianPath, { bigint: true });
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.lastIndexOf(")");
    const fields = tail >= 0 ? stat.slice(tail + 2).trim().split(/\s+/u) : [];
    if (Number(fields[3]) !== pid || match[5] !== String(trusted.dev)
      || match[6] !== String(trusted.ino)) return null;
    return {
      pid, parentPid: expectedParentPid, processGroupId: pid, startTimeTicks: startTimeTicks!,
      guardianExecutableDevice: String(trusted.dev), guardianExecutableInode: String(trusted.ino),
    };
  } catch {
    return null;
  }
}

export function readLinuxGuardianClaimed(
  pid: number,
  guardianPath: string,
  expectedParentPid: number,
): LinuxProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !isAbsolute(guardianPath)) return null;
  const result = spawnSync(guardianPath, ["claimed", String(pid)], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: 1_500, maxBuffer: 4 * 1024,
  });
  if (result.error || result.status !== 0 || result.signal || result.stderr !== "") return null;
  const match = result.stdout.trim().match(/^([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)\|([1-9][0-9]*)$/u);
  if (!match || Number(match[1]) !== pid || Number(match[2]) !== expectedParentPid
    || Number(match[3]) !== pid) return null;
  try {
    const trusted = statSync(guardianPath, { bigint: true });
    if (match[5] !== String(trusted.dev) || match[6] !== String(trusted.ino)) return null;
    return {
      pid, parentPid: expectedParentPid, processGroupId: pid, startTimeTicks: match[4]!,
      guardianExecutableDevice: String(trusted.dev), guardianExecutableInode: String(trusted.ino),
    };
  } catch { return null; }
}

export function linuxGuardianTerminalAuthority(
  expected: LinuxProcessIdentity,
  _guardianPath: string,
  procRoot = "/proc",
): boolean {
  try {
    const stat = readFileSync(`${procRoot}/${expected.pid}/stat`, "utf8");
    const tail = stat.lastIndexOf(")");
    const statFields = tail >= 0 ? stat.slice(tail + 2).trim().split(/\s+/u) : [];
    const fields = new Map<string, string>();
    for (const line of readFileSync(`${procRoot}/${expected.pid}/status`, "utf8").split("\n")) {
      const separator = line.indexOf(":");
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
    const children = readFileSync(`${procRoot}/${expected.pid}/task/${expected.pid}/children`, "utf8").trim();
    return fields.get("Name") === "inertia-done"
      && statFields[19] === expected.startTimeTicks
      && Number(statFields[2]) === expected.processGroupId
      && (fields.get("State") ?? "").startsWith("T")
      && fields.get("TracerPid") === "0"
      && fields.get("Threads") === "1"
      && fields.get("NoNewPrivs") === "1"
      && fields.get("Seccomp") === "2"
      && (fields.get("Seccomp_filters") === undefined
        || Number(fields.get("Seccomp_filters")) >= 1)
      && children === ""
      && expected.guardianExecutableDevice !== undefined
      && expected.guardianExecutableInode !== undefined
      && expected.guardianExecutableDevice !== ""
      && expected.guardianExecutableInode !== "";
  } catch {
    return false;
  }
}

export function signalLinuxGuardianExact(
  expected: LinuxProcessIdentity,
  guardianPath: string,
  action: "claim" | "exec" | "release" | "kill" | "stop",
): boolean {
  if (!isAbsolute(guardianPath)
    || !expected.guardianExecutableDevice
    || !expected.guardianExecutableInode) return false;
  let helper;
  try { helper = statSync(guardianPath, { bigint: true }); } catch { return false; }
  const result = spawnSync(guardianPath, [
    "signal",
    String(expected.pid),
    expected.startTimeTicks,
    String(helper.dev),
    String(helper.ino),
    action,
  ], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, shell: false,
    timeout: 1_500, maxBuffer: 4 * 1024,
  });
  return !result.error && result.status === 0 && !result.signal
    && result.stdout === "" && result.stderr === "";
}

export function monitorLinuxGuardianTerminal(
  expected: LinuxProcessIdentity,
  guardianPath: string,
  onTerminal: () => boolean,
  onFailure: () => void,
  dependencies: {
    readonly readComm?: () => string;
    readonly terminalAuthority?: () => boolean;
    readonly release?: () => boolean;
  } = {},
): () => void {
  let unprovedTerminalPolls = 0;
  const timer = setInterval(() => {
    let comm: string;
    try {
      comm = dependencies.readComm?.()
        ?? readFileSync(`/proc/${expected.pid}/comm`, "utf8").trim();
    } catch {
      clearInterval(timer);
      onFailure();
      return;
    }
    if (comm === "inertia-bad") {
      clearInterval(timer);
      onFailure();
      return;
    }
    if (comm !== "inertia-done") { unprovedTerminalPolls = 0; return; }
    if (!(dependencies.terminalAuthority?.()
      ?? linuxGuardianTerminalAuthority(expected, guardianPath))) {
      unprovedTerminalPolls += 1;
      if (unprovedTerminalPolls >= 20) {
        // A claimed terminal marker without exact hardened authority is unsafe.
        clearInterval(timer);
        onFailure();
      }
      return;
    }
    if (!onTerminal()) return;
    if ((dependencies.release?.()
      ?? signalLinuxGuardianExact(expected, guardianPath, "release"))) clearInterval(timer);
  }, 50);
  timer.unref();
  return () => clearInterval(timer);
}
