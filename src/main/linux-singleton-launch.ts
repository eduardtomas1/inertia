import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { InertiaReleaseChannel } from "./release-channel.js";
import { readLinuxSingletonManifest } from "./linux-singleton-metadata.js";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
// This is a launch grace period, not authority to extend or bypass cleanup.
// Longer cleanup remains with its owner; the notice asks the user to reopen.
const WAIT_MS = 5_000;
const POLL_MS = 100;

export interface LinuxSingletonContention {
  readonly requestedVersion: string;
  readonly runningVersion: string | null;
}

interface Owner {
  readonly lock: string;
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly version: string;
}

interface Inspection {
  readLink(path: string): string;
  readText(path: string, maxBytes: number): string;
  readManifest(archivePath: string, maxBytes: number): string;
  realPath(path: string): string;
  processUser(path: string): number;
  readonly hostname: string;
  readonly uid: number;
}

interface LaunchOptions {
  readonly profileDirectory: string;
  readonly channel: InertiaReleaseChannel;
  readonly version: string;
  requestLock(): boolean;
  reportContention(notice: LinuxSingletonContention): void | Promise<void>;
}

/** Bounds procfs reads too: proc files report a zero stat size. */
function readBoundedText(path: string, maxBytes: number): string {
  const named = lstatSync(path);
  if (!named.isFile()) throw new Error("Invalid singleton metadata.");
  if (!Number.isSafeInteger(named.size) || named.size > maxBytes) {
    throw new Error("Oversized singleton metadata.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("Invalid singleton metadata.");
    if (!Number.isSafeInteger(opened.size) || opened.size > maxBytes) {
      throw new Error("Oversized singleton metadata.");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > maxBytes) throw new Error("Oversized singleton metadata.");
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

function defaults(): Inspection {
  return {
    readLink: readlinkSync,
    readText: readBoundedText,
    readManifest: readLinuxSingletonManifest,
    realPath: realpathSync,
    processUser: (path) => {
      const metadata = statSync(path);
      if (!metadata.isDirectory()) throw new Error("Invalid singleton process.");
      return metadata.uid;
    },
    hostname: hostname(),
    uid: process.geteuid?.() ?? -1,
  };
}

function startTime(pid: number, inspection: Inspection): string {
  const value = inspection.readText(`/proc/${pid}/stat`, 16_384);
  const closingName = value.lastIndexOf(")");
  const fields = value.slice(closingName + 2).trim().split(/\s+/u);
  const ticks = fields[19];
  if (
    closingName < 2 || !value.startsWith(`${pid} (`)
    || !ticks || !/^\d+$/u.test(ticks)
    || !/^[RSDTtWIP]$/u.test(fields[0] ?? "")
  ) throw new Error("Invalid singleton process identity.");
  return ticks;
}

function inspectOwner(options: LaunchOptions, inspection: Inspection): Owner | null {
  try {
    const lockPath = join(options.profileDirectory, "SingletonLock");
    const lock = inspection.readLink(lockPath);
    const prefix = `${inspection.hostname}-`;
    const pidText = lock.slice(prefix.length);
    const pid = Number(pidText);
    if (
      !lock.startsWith(prefix) || !/^[1-9]\d*$/u.test(pidText)
      || !Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid
      || inspection.uid < 0
      || inspection.processUser(`/proc/${pid}`) !== inspection.uid
    ) return null;
    const birth = startTime(pid, inspection);
    const executable = inspection.readLink(`/proc/${pid}/exe`);
    const name = options.channel === "canary" ? "inertia-canary" : "inertia";
    if (
      !isAbsolute(executable) || executable.length > 4_096
      || basename(executable) !== name
      || inspection.realPath(executable) !== executable
    ) return null;
    const argv = inspection.readText(`/proc/${pid}/cmdline`, 16_384).split("\0");
    // Electron's Linux main rewrites its process title into one command-line
    // string. Match the complete known executable before inspecting its flags;
    // ordinary processes still use the kernel's NUL-separated argv format.
    const flattened = argv[0]?.startsWith(`${executable} `)
      && argv.slice(1).every((argument) => argument === "");
    const args = flattened
      ? argv[0]!.slice(executable.length + 1).split(/\s+/u)
      : argv.slice(1);
    // An AppImage FUSE wrapper or renderer is never the Electron main owner.
    if (
      (!flattened && argv[0] !== executable)
      || args.some((argument) => argument === "--type" || argument.startsWith("--type="))
    ) return null;
    // Read bounded archive bytes without loading or extracting owner code.
    // Do not infer a version from an AppImage filename.
    const manifest: unknown = JSON.parse(inspection.readManifest(
      join(dirname(executable), "resources", "app.asar"), 65_536,
    ));
    if (
      !manifest || typeof manifest !== "object"
      || !("name" in manifest) || manifest.name !== name
      || !("main" in manifest) || manifest.main !== "out/main/index.js"
      || !("inertiaReleaseChannel" in manifest) || manifest.inertiaReleaseChannel !== options.channel
      || !("version" in manifest) || typeof manifest.version !== "string"
      || manifest.version.length > 100 || !VERSION_PATTERN.test(manifest.version)
      || inspection.readLink(lockPath) !== lock
      || startTime(pid, inspection) !== birth
      || inspection.readLink(`/proc/${pid}/exe`) !== executable
    ) return null;
    return { lock, pid, startTime: birth, executable, version: manifest.version };
  } catch {
    return null;
  }
}

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error
    && (error.code === "ENOENT" || error.code === "ESRCH");
}

function ownerState(
  options: LaunchOptions, owner: Owner, inspection: Inspection,
): "retained" | "released" | "changed" {
  try {
    if (inspection.readLink(join(options.profileDirectory, "SingletonLock")) !== owner.lock) {
      return "changed";
    }
  } catch (error) {
    return missing(error) ? "released" : "changed";
  }
  try {
    if (startTime(owner.pid, inspection) !== owner.startTime) return "changed";
  } catch (error) {
    return missing(error) ? "released" : "changed";
  }
  try {
    return inspection.processUser(`/proc/${owner.pid}`) === inspection.uid
      && inspection.readLink(`/proc/${owner.pid}/exe`) === owner.executable
      ? "retained" : "changed";
  } catch {
    return "changed";
  }
}

/**
 * A losing ordinary AppImage launcher may wait for a different version to
 * finish its own shutdown. Observations grant no process or profile mutation:
 * only Electron can grant the singleton, and candidates retain their separate
 * authenticated update admission path.
 */
export async function requestLinuxSingletonLaunch(
  options: LaunchOptions,
  dependencies: Partial<Inspection> & {
    now?(): number;
    wait?(milliseconds: number): Promise<void>;
  } = {},
): Promise<boolean> {
  const inspection = { ...defaults(), ...dependencies };
  // Capture the owner before the notification can finish its pending cleanup.
  const owner = inspectOwner(options, inspection);
  if (options.requestLock()) return true;
  if (owner?.version === options.version) return false;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? ((milliseconds) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const deadline = now() + WAIT_MS;
  let runningVersion = owner?.version ?? null;
  if (owner) {
    // Never repeat notifications to a healthy owner while waiting. A new lock
    // attempt is allowed only after the observed owner exits or releases it.
    for (let remainingPolls = WAIT_MS / POLL_MS; remainingPolls >= 0; remainingPolls -= 1) {
      const state = ownerState(options, owner, inspection);
      if (state === "released") {
        if (options.requestLock()) return true;
        runningVersion = null;
        break;
      }
      if (state === "changed") {
        runningVersion = null;
        break;
      }
      const remaining = deadline - now();
      if (remaining <= 0 || remainingPolls === 0) break;
      await wait(Math.min(POLL_MS, remaining));
    }
  }
  try {
    await options.reportContention({ requestedVersion: options.version, runningVersion });
  } catch {
    // A native notice may fail while Electron is exiting. That never grants
    // singleton ownership or permits normal bootstrap.
  }
  return false;
}
