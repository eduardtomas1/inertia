import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statfsSync,
  statSync,
} from "node:fs";
import { posix } from "node:path";

export const LINUX_INIT_CGROUP_NAMESPACE = "cgroup:[4026531835]";
const CGROUP2_SUPER_MAGIC = 0x63677270;
const MAX_CGROUP_PATH_BYTES = 256;
const MAX_CGROUP_FILE_BYTES = 4_096;
const CGROUP_COMPONENT_PATTERN = /^[A-Za-z0-9._@:+\\-]{1,255}$/u;

export interface LinuxCgroupContainment {
  readonly cgroupPath: string;
  readonly cgroupNamespace: string;
}

export interface LinuxCgroupProbe {
  readonly procRoot?: string;
  readonly cgroupRoot?: string;
  readonly filesystemType?: (path: string) => number;
}

interface LinuxCgroupProcessIdentity {
  readonly pid: number;
  readonly cgroupPath?: string;
  readonly cgroupNamespace?: string;
}

function errorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

export function validLinuxCgroupPath(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !value.startsWith("/")
    || Buffer.byteLength(value, "utf8") > MAX_CGROUP_PATH_BYTES
  ) return false;
  return value.slice(1).split("/").every((component) =>
    component !== "."
    && component !== ".."
    && CGROUP_COMPONENT_PATTERN.test(component));
}

export function validLinuxCgroupContainment(
  cgroupPath: unknown,
  cgroupNamespace: unknown,
): boolean {
  return validLinuxCgroupPath(cgroupPath)
    && cgroupNamespace === LINUX_INIT_CGROUP_NAMESPACE;
}

function unifiedHierarchyAvailable(probe: LinuxCgroupProbe): boolean {
  const procRoot = probe.procRoot ?? "/proc";
  const cgroupRoot = probe.cgroupRoot ?? "/sys/fs/cgroup";
  const filesystemType = probe.filesystemType
    ?? ((path: string) => statfsSync(path).type);
  return readlinkSync(`${procRoot}/self/ns/cgroup`)
      === LINUX_INIT_CGROUP_NAMESPACE
    && filesystemType(cgroupRoot) === CGROUP2_SUPER_MAGIC;
}

export function readLinuxProcessCgroup(
  pid: number,
  probe: LinuxCgroupProbe = {},
): LinuxCgroupContainment | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    if (!unifiedHierarchyAvailable(probe)) return null;
    const membership = readFileSync(
      `${probe.procRoot ?? "/proc"}/${pid}/cgroup`,
      "utf8",
    );
    if (membership.length > MAX_CGROUP_FILE_BYTES) return null;
    const match = membership.match(/^0::(\/[^\n]*)\n?$/u);
    return match && validLinuxCgroupPath(match[1])
      ? { cgroupPath: match[1], cgroupNamespace: LINUX_INIT_CGROUP_NAMESPACE }
      : null;
  } catch {
    return null;
  }
}

function cgroupUnpopulated(cgroupRoot: string, cgroupPath: string): boolean {
  let events: string;
  try {
    events = readFileSync(`${cgroupRoot}${cgroupPath}/cgroup.events`, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return false;
    try {
      lstatSync(`${cgroupRoot}${cgroupPath}`);
      return false;
    } catch (missing) {
      if (errorCode(missing) !== "ENOENT") return false;
    }
    const parent = posix.dirname(cgroupPath);
    return statSync(
      `${cgroupRoot}${parent === "/" ? "" : parent}/cgroup.procs`,
    ).isFile();
  }
  return events.length <= MAX_CGROUP_FILE_BYTES
    && events.split("\n").includes("populated 0");
}

function linuxSessionOccupied(
  procRoot: string,
  sessionId: number,
  reusedHolderStartTimeTicks: string | null,
): boolean {
  for (const name of readdirSync(procRoot)) {
    if (!/^[1-9][0-9]*$/u.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procRoot}/${name}/stat`, "utf8");
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ESRCH") continue;
      throw error;
    }
    const closingName = stat.lastIndexOf(")");
    const fields = closingName < 0
      ? []
      : stat.slice(closingName + 2).trim().split(/\s+/u);
    const session = Number(fields[3]);
    const startTimeTicks = fields[19];
    if (
      !Number.isSafeInteger(session)
      || !startTimeTicks
      || !/^[0-9]{1,31}$/u.test(startTimeTicks)
    ) throw new Error("A process identity could not be read.");
    if (session !== sessionId) continue;
    if (
      reusedHolderStartTimeTicks !== null
      && BigInt(startTimeTicks) >= BigInt(reusedHolderStartTimeTicks)
    ) continue;
    return true;
  }
  return false;
}

export function linuxGuardianProcessTreeGone(
  identity: LinuxCgroupProcessIdentity,
  reusedHolderStartTimeTicks: string | null,
  probe: LinuxCgroupProbe = {},
): boolean {
  if (
    !validLinuxCgroupContainment(identity.cgroupPath, identity.cgroupNamespace)
    || (reusedHolderStartTimeTicks !== null
      && !/^[1-9][0-9]{0,30}$/u.test(reusedHolderStartTimeTicks))
  ) return false;
  try {
    return unifiedHierarchyAvailable(probe)
      && cgroupUnpopulated(
        probe.cgroupRoot ?? "/sys/fs/cgroup",
        identity.cgroupPath!,
      )
      && !linuxSessionOccupied(
        probe.procRoot ?? "/proc",
        identity.pid,
        reusedHolderStartTimeTicks,
      );
  } catch {
    return false;
  }
}
