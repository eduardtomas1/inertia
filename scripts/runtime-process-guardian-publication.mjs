import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const maximumExecutableSize = 1024 * 1024;
// PID reuse is bounded without allowing normal hosted packaging (including a
// slow signing/notarization queue) to lose live ownership.
const ownershipLeaseMs = 4 * 60 * 60_000;
const malformedLockGraceMs = ownershipLeaseMs;

function wait(milliseconds) {
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function writeAll(descriptor, content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
    );
    if (written <= 0)
      throw new Error("Could not complete a durable file write.");
    offset += written;
  }
}

function createDurableFile(path, content, mode) {
  let descriptor;
  let created = false;
  let operationError;
  try {
    descriptor = openSync(path, "wx", mode);
    created = true;
    writeAll(descriptor, content);
    fsyncSync(descriptor);
  } catch (error) {
    operationError = error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      operationError ??= error;
    }
  }
  if (operationError) {
    if (created) rmSync(path, { force: true });
    throw operationError;
  }
}

export function guardianFileSyncOpenFlags(platform = process.platform) {
  // Windows rejects FlushFileBuffers (Node's fsync) for handles opened without
  // write access. Every file passed to syncFile is an Inertia-owned lock,
  // staging, backup, or publication artifact, so requesting write access is
  // both safe and required there. Keep the narrower read-only handle elsewhere.
  return platform === "win32" ? "r+" : "r";
}

function syncFile(path) {
  let descriptor;
  try {
    descriptor = openSync(path, guardianFileSyncOpenFlags());
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function syncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform !== "win32" ||
      !["EACCES", "EBADF", "EINVAL", "EPERM"].includes(error?.code)
    )
      throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validLockRecord(record) {
  return (
    record?.version === 1 &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.token === "string" &&
    /^[0-9a-f-]{36}$/u.test(record.token) &&
    Number.isSafeInteger(record.createdAtMs) &&
    Number.isSafeInteger(record.expiresAtMs) &&
    record.expiresAtMs > record.createdAtMs &&
    (record.processIdentity === undefined ||
      record.processIdentity === null ||
      typeof record.processIdentity === "string")
  );
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function linuxProcessIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    const startTicks = fields[19];
    if (
      !/^[0-9a-f-]{36}$/u.test(boot) ||
      !/^[1-9][0-9]*$/u.test(startTicks ?? "")
    )
      return null;
    return `linux:${boot}:${startTicks}`;
  } catch {
    return null;
  }
}

function processIdentity(pid) {
  const trace =
    process.env.NODE_ENV === "test"
      ? process.env.INERTIA_TEST_PROCESS_IDENTITY_TRACE
      : undefined;
  if (typeof trace === "string" && isAbsolute(trace)) {
    appendFileSync(trace, `${String(pid)}\n`, "utf8");
  }
  if (
    process.env.NODE_ENV === "test" &&
    process.env.INERTIA_TEST_PROCESS_IDENTITY_FORCE_NULL_PID === String(pid)
  ) {
    return null;
  }
  const linux = linuxProcessIdentity(pid);
  if (linux !== null || process.platform === "linux") return linux;
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      maxBuffer: 4_096,
      shell: false,
      timeout: 2_000,
    });
    const value = result.status === 0 ? result.stdout.trim() : "";
    return /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] [0-9:]{8} [0-9]{4}$/u.test(
      value,
    )
      ? `darwin:${value}`
      : null;
  }
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) {
      return null;
    }
    const powershell = win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = spawnSync(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`,
      ],
      {
        encoding: "utf8",
        maxBuffer: 4_096,
        shell: false,
        timeout: 5_000,
        windowsHide: true,
      },
    );
    const value = result.status === 0 ? result.stdout.trim() : "";
    return /^[1-9][0-9]{16,18}$/u.test(value) ? `win32:${value}` : null;
  }
  return null;
}

function processGroupIsAlive(processGroupId) {
  if (process.platform === "win32" || !Number.isSafeInteger(processGroupId)) {
    return false;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function childAuthorityPath(stateDirectory, token) {
  return join(stateDirectory, `child-${token}.json`);
}

function childAuthorityIsActive(stateDirectory, record) {
  const path = childAuthorityPath(stateDirectory, record.token);
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata) return false;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > 4_096
  )
    return Date.now() - metadata.mtimeMs <= ownershipLeaseMs;
  let authority;
  try {
    authority = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return Date.now() - metadata.mtimeMs <= ownershipLeaseMs;
  }
  if (authority?.version !== 1 || authority.token !== record.token) {
    return Date.now() - metadata.mtimeMs <= ownershipLeaseMs;
  }
  if (authority.state === "pending") {
    // A pending authority is an admission trampoline which cannot launch its
    // payload until the owning wrapper records `running` and sends GO. This
    // function is reached only after the lock owner is proven dead/reused, so
    // no live wrapper remains that could admit it.
    return false;
  }
  if (authority.state === "cleanup-unconfirmed") {
    return Date.now() - metadata.mtimeMs <= ownershipLeaseMs;
  }
  if (
    authority.state !== "running" ||
    !Number.isSafeInteger(authority.pid) ||
    authority.pid <= 0 ||
    (authority.processGroupId !== null &&
      (!Number.isSafeInteger(authority.processGroupId) ||
        authority.processGroupId <= 0))
  )
    return Date.now() - metadata.mtimeMs <= ownershipLeaseMs;
  if (processGroupIsAlive(authority.processGroupId)) return true;
  if (!processIsAlive(authority.pid)) return false;
  const currentIdentity = processIdentity(authority.pid);
  if (typeof authority.processIdentity !== "string") {
    return Date.now() - metadata.mtimeMs <= ownershipLeaseMs;
  }
  if (currentIdentity === null) {
    return Date.now() - metadata.mtimeMs <= ownershipLeaseMs;
  }
  return currentIdentity === authority.processIdentity;
}

function claimMalformedLock(stateDirectory, lockPath, metadata, beforeUnlink) {
  const claimPath = join(
    stateDirectory,
    `reclaim-malformed-${metadata.dev}-${metadata.ino}`,
  );
  if (Date.now() - metadata.mtimeMs < malformedLockGraceMs) {
    const existingClaim = lstatSync(claimPath, { throwIfNoEntry: false });
    const sameClaim =
      existingClaim &&
      existingClaim.dev === metadata.dev &&
      existingClaim.ino === metadata.ino;
    const sameOwner = readdirSync(stateDirectory).some((name) => {
      if (!name.startsWith("owner-")) return false;
      const owner = lstatSync(join(stateDirectory, name), {
        throwIfNoEntry: false,
      });
      return owner && owner.dev === metadata.dev && owner.ino === metadata.ino;
    });
    if (!sameClaim && sameOwner) return false;
  }
  try {
    linkSync(lockPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "EEXIST") {
      const claim = lstatSync(claimPath, { throwIfNoEntry: false });
      if (!claim || claim.dev !== metadata.dev || claim.ino !== metadata.ino) {
        return false;
      }
    } else {
      throw error;
    }
  }
  beforeUnlink?.();
  const current = lstatSync(lockPath, { throwIfNoEntry: false });
  const claim = lstatSync(claimPath, { throwIfNoEntry: false });
  if (
    current &&
    claim &&
    current.dev === claim.dev &&
    current.ino === claim.ino
  ) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    syncDirectory(stateDirectory);
    rmSync(claimPath, { force: true });
    return true;
  }
  rmSync(claimPath, { force: true });
  return false;
}

export function reclaimStaleGuardianBuildLock(
  stateDirectory,
  lockPath,
  { beforeUnlink } = {},
) {
  const metadata = lstatSync(lockPath, { throwIfNoEntry: false });
  if (!metadata) return true;
  if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
  let record;
  try {
    record = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return claimMalformedLock(stateDirectory, lockPath, metadata, beforeUnlink);
  }
  if (!validLockRecord(record)) {
    return claimMalformedLock(stateDirectory, lockPath, metadata, beforeUnlink);
  }
  const ownerPath = join(stateDirectory, `owner-${record.token}`);
  const owner = lstatSync(ownerPath, { throwIfNoEntry: false });
  if (!owner || owner.dev !== metadata.dev || owner.ino !== metadata.ino) {
    if (childAuthorityIsActive(stateDirectory, record)) return false;
    return claimMalformedLock(stateDirectory, lockPath, metadata, beforeUnlink);
  }
  if (processIsAlive(record.pid)) {
    const currentIdentity = processIdentity(record.pid);
    if (typeof record.processIdentity !== "string") {
      if (Date.now() - owner.mtimeMs <= ownershipLeaseMs) return false;
    } else if (currentIdentity === null) {
      if (Date.now() - owner.mtimeMs <= ownershipLeaseMs) return false;
    } else if (currentIdentity === record.processIdentity) return false;
  }
  if (childAuthorityIsActive(stateDirectory, record)) return false;
  const claimPath = join(stateDirectory, `reclaim-${record.token}`);
  try {
    linkSync(ownerPath, claimPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "EEXIST") {
      const claim = lstatSync(claimPath, { throwIfNoEntry: false });
      if (!claim || claim.dev !== owner.dev || claim.ino !== owner.ino) {
        return false;
      }
    } else {
      throw error;
    }
  }
  try {
    unlinkSync(ownerPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  beforeUnlink?.();
  const current = lstatSync(lockPath, { throwIfNoEntry: false });
  const claim = lstatSync(claimPath, { throwIfNoEntry: false });
  if (
    current &&
    claim &&
    current.dev === claim.dev &&
    current.ino === claim.ino
  ) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    rmSync(childAuthorityPath(stateDirectory, record.token), { force: true });
    syncDirectory(stateDirectory);
    rmSync(claimPath, { force: true });
    return true;
  }
  rmSync(claimPath, { force: true });
  return false;
}

export function acquireGuardianBuildLock(
  stateDirectory,
  { timeoutMs = 180_000 } = {},
) {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o755 });
  const lockPath = join(stateDirectory, "build.lock");
  const startedAt = Date.now();
  const ownProcessIdentity = processIdentity(process.pid);
  const token = randomUUID();
  const ownerPath = join(stateDirectory, `owner-${token}`);
  const createdAtMs = Date.now();
  createDurableFile(
    ownerPath,
    JSON.stringify({
      createdAtMs,
      expiresAtMs: createdAtMs + ownershipLeaseMs,
      pid: process.pid,
      processIdentity: ownProcessIdentity,
      token,
      version: 1,
    }),
    0o600,
  );
  let lastObservedLock = null;
  let lastReclaimAttemptMs = 0;
  while (true) {
    try {
      linkSync(ownerPath, lockPath);
      return { lockPath, ownerPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        rmSync(ownerPath, { force: true });
        throw error;
      }
      const lockMetadata = lstatSync(lockPath, { throwIfNoEntry: false });
      const observedLock = lockMetadata
        ? `${String(lockMetadata.dev)}:${String(lockMetadata.ino)}:${String(lockMetadata.mtimeMs)}:${String(lockMetadata.size)}`
        : "absent";
      const now = Date.now();
      if (
        observedLock !== lastObservedLock ||
        now - lastReclaimAttemptMs >= 1_000
      ) {
        lastObservedLock = observedLock;
        lastReclaimAttemptMs = now;
        if (reclaimStaleGuardianBuildLock(stateDirectory, lockPath)) continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        rmSync(ownerPath, { force: true });
        throw new Error(
          "Timed out waiting for the runtime guardian build lock.",
        );
      }
      wait(25);
    }
  }
}

export function releaseGuardianBuildLock(lock) {
  if (lock.heartbeat) clearInterval(lock.heartbeat);
  try {
    const fixed = lstatSync(lock.lockPath, { throwIfNoEntry: false });
    const owner = lstatSync(lock.ownerPath, { throwIfNoEntry: false });
    const record = fixed?.isFile()
      ? JSON.parse(readFileSync(lock.lockPath, "utf8"))
      : null;
    if (
      fixed &&
      owner &&
      fixed.dev === owner.dev &&
      fixed.ino === owner.ino &&
      record?.token === lock.token
    ) {
      unlinkSync(lock.lockPath);
      syncDirectory(dirname(lock.lockPath));
    }
  } catch {
    // A replaced or already-recovered lock does not belong to this process.
  } finally {
    rmSync(childAuthorityPath(dirname(lock.ownerPath), lock.token), {
      force: true,
    });
    rmSync(lock.ownerPath, { force: true });
    try {
      syncDirectory(dirname(lock.ownerPath));
    } catch {
      // Ownership is already released; a directory sync is best effort here.
    }
  }
}

function assertGuardianBuildLock(lock) {
  const fixed = lstatSync(lock.lockPath, { throwIfNoEntry: false });
  const owner = lstatSync(lock.ownerPath, { throwIfNoEntry: false });
  if (
    !fixed ||
    !owner ||
    fixed.dev !== owner.dev ||
    fixed.ino !== owner.ino ||
    JSON.parse(readFileSync(lock.lockPath, "utf8"))?.token !== lock.token
  )
    throw new Error("The runtime guardian build lock was replaced.");
}

export function beginGuardianBuildChildLaunch(lock) {
  assertGuardianBuildLock(lock);
  createDurableFile(
    childAuthorityPath(dirname(lock.ownerPath), lock.token),
    `${JSON.stringify({ state: "pending", token: lock.token, version: 1 })}\n`,
    0o600,
  );
  syncDirectory(dirname(lock.ownerPath));
}

export function recordGuardianBuildChild(lock, { pid, processGroupId }) {
  assertGuardianBuildLock(lock);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    (processGroupId !== null &&
      (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  )
    throw new Error("The guardian build child identity is invalid.");
  const directory = dirname(lock.ownerPath);
  const staged = join(directory, `.child-${lock.token}.${randomUUID()}.tmp`);
  createDurableFile(
    staged,
    `${JSON.stringify({
      pid,
      processGroupId,
      processIdentity: processIdentity(pid),
      state: "running",
      token: lock.token,
      version: 1,
    })}\n`,
    0o600,
  );
  renameSync(staged, childAuthorityPath(directory, lock.token));
  syncDirectory(directory);
}

export function clearGuardianBuildChild(lock) {
  rmSync(childAuthorityPath(dirname(lock.ownerPath), lock.token), {
    force: true,
  });
  syncDirectory(dirname(lock.ownerPath));
}

export function quarantineGuardianBuildChild(lock) {
  assertGuardianBuildLock(lock);
  const directory = dirname(lock.ownerPath);
  const path = childAuthorityPath(directory, lock.token);
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The guardian build child authority is unavailable.");
  }
  const authority = JSON.parse(readFileSync(path, "utf8"));
  if (authority?.version !== 1 || authority.token !== lock.token) {
    throw new Error("The guardian build child authority is invalid.");
  }
  const staged = join(directory, `.child-${lock.token}.${randomUUID()}.tmp`);
  createDurableFile(
    staged,
    `${JSON.stringify({
      ...authority,
      quarantinedAtMs: Date.now(),
      state: "cleanup-unconfirmed",
    })}\n`,
    0o600,
  );
  renameSync(staged, path);
  syncDirectory(directory);
}

export function renewGuardianBuildLock(lock) {
  assertGuardianBuildLock(lock);
  const now = new Date();
  utimesSync(lock.ownerPath, now, now);
  syncFile(lock.ownerPath);
}

export function startGuardianBuildLockHeartbeat(
  lock,
  { intervalMs = 30_000, onCompromised } = {},
) {
  if (lock.heartbeat)
    throw new Error("The guardian build lock heartbeat is already active.");
  const heartbeat = setInterval(
    () => {
      try {
        renewGuardianBuildLock(lock);
      } catch (error) {
        clearInterval(heartbeat);
        lock.heartbeat = null;
        onCompromised?.(error);
      }
    },
    Math.max(1, Math.trunc(intervalMs)),
  );
  heartbeat.unref();
  lock.heartbeat = heartbeat;
  return () => {
    if (lock.heartbeat === heartbeat) lock.heartbeat = null;
    clearInterval(heartbeat);
  };
}

export function cleanGuardianLockArtifacts(stateDirectory, lock) {
  const fixed = lstatSync(lock.lockPath, { throwIfNoEntry: false });
  for (const name of readdirSync(stateDirectory)) {
    if (!name.startsWith("reclaim-")) continue;
    const path = join(stateDirectory, name);
    const candidate = lstatSync(path, { throwIfNoEntry: false });
    if (
      !candidate ||
      !fixed ||
      candidate.dev !== fixed.dev ||
      candidate.ino !== fixed.ino
    )
      rmSync(path, { force: true });
  }
}

export function validateGuardianExecutable(path, label) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= 0 ||
    metadata.size > maximumExecutableSize
  )
    throw new Error(`${label} compiler did not produce a valid executable.`);
}

function validateExistingTarget(path) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(
      `Refusing to replace invalid guardian build target ${basename(path)}.`,
    );
  }
  return metadata;
}

function transactionDirectory(stateDirectory, transactionId) {
  return join(stateDirectory, `transaction-${transactionId}`);
}

function journalPath(stateDirectory) {
  return join(stateDirectory, "publication-journal.json");
}

function restoreTransaction(stateDirectory, targets, journal) {
  if (
    journal?.version !== 1 ||
    typeof journal.transactionId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(journal.transactionId) ||
    !Array.isArray(journal.entries) ||
    journal.entries.length !== 3
  )
    throw new Error("The runtime guardian publication journal is invalid.");

  const directory = transactionDirectory(stateDirectory, journal.transactionId);
  const expected = ["guardian", "windowsJob", "integrity"];
  for (const [index, key] of expected.entries()) {
    const entry = journal.entries[index];
    if (
      entry?.key !== key ||
      typeof entry.existed !== "boolean" ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      throw new Error("The runtime guardian publication journal is invalid.");
    const target = targets[key];
    if (entry.existed) {
      const backup = join(directory, `${key}.backup`);
      const restore = join(directory, `${key}.${randomUUID()}.restore`);
      copyFileSync(backup, restore, constants.COPYFILE_EXCL);
      chmodSync(restore, entry.mode);
      syncFile(restore);
      renameSync(restore, target);
    } else {
      rmSync(target, { force: true });
    }
  }
  for (const directoryPath of new Set(Object.values(targets).map(dirname))) {
    syncDirectory(directoryPath);
  }
  rmSync(journalPath(stateDirectory), { force: true });
  syncDirectory(stateDirectory);
  rmSync(directory, { recursive: true, force: true });
}

export function recoverGuardianPublication(stateDirectory, targets) {
  const path = journalPath(stateDirectory);
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata) return false;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The runtime guardian publication journal is invalid.");
  }
  const journal = JSON.parse(readFileSync(path, "utf8"));
  restoreTransaction(stateDirectory, targets, journal);
  return true;
}

export function cleanLegacyGuardianStages(targets) {
  const directories = new Set([
    dirname(targets.guardian),
    dirname(targets.integrity),
  ]);
  const legacyStage =
    /^\.(?:runtime-process-guardian|windows-runtime-job\.exe|windows-runtime-job-integrity\.json)\.\d+\.[0-9a-f-]{36}\.tmp(?:\.exe)?$/u;
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (legacyStage.test(name)) {
        rmSync(join(directory, name), { force: true });
      }
    }
  }
}

export function cleanGuardianBuildState(stateDirectory) {
  const publicationInterrupted = Boolean(
    lstatSync(journalPath(stateDirectory), { throwIfNoEntry: false }),
  );
  for (const name of readdirSync(stateDirectory)) {
    if (
      name.startsWith("compile-") ||
      name.startsWith(".child-") ||
      name.startsWith(".publication-journal.") ||
      (!publicationInterrupted && name.startsWith("transaction-"))
    )
      rmSync(join(stateDirectory, name), { recursive: true, force: true });
  }
}

export function validateGuardianArtifactSet(platform, targets, expectedHash) {
  const guardian = lstatSync(targets.guardian, { throwIfNoEntry: false });
  const windowsJob = lstatSync(targets.windowsJob, { throwIfNoEntry: false });
  const integrity = JSON.parse(readFileSync(targets.integrity, "utf8"));
  if (platform === "win32") {
    validateGuardianExecutable(
      targets.windowsJob,
      "The Windows runtime Job Object",
    );
    const publishedHash = createHash("sha256")
      .update(readFileSync(targets.windowsJob))
      .digest("hex");
    if (
      guardian ||
      !/^[0-9a-f]{64}$/u.test(integrity.sha256 ?? "") ||
      (expectedHash !== undefined && integrity.sha256 !== expectedHash) ||
      publishedHash !== integrity.sha256
    ) {
      throw new Error(
        "The Windows runtime guardian artifact set is inconsistent.",
      );
    }
    return;
  }
  if (platform === "darwin" || platform === "linux") {
    validateGuardianExecutable(
      targets.guardian,
      `The ${platform} runtime process guardian`,
    );
    if (windowsJob || integrity.sha256 !== null) {
      throw new Error(
        `The ${platform} runtime guardian artifact set is inconsistent.`,
      );
    }
    return;
  }
  if (guardian || windowsJob || integrity.sha256 !== null) {
    throw new Error(
      "The unsupported-platform guardian artifact set is inconsistent.",
    );
  }
}

export function publishGuardianArtifacts({
  expectedWindowsHash,
  failAfterOperation,
  platform,
  stagedExecutable,
  stateDirectory,
  targets,
}) {
  if (platform === "win32") {
    validateGuardianExecutable(
      stagedExecutable,
      "The Windows runtime Job Object",
    );
    const stagedHash = createHash("sha256")
      .update(readFileSync(stagedExecutable))
      .digest("hex");
    if (
      !/^[0-9a-f]{64}$/u.test(expectedWindowsHash ?? "") ||
      stagedHash !== expectedWindowsHash
    ) {
      throw new Error("The Windows runtime guardian hash is invalid.");
    }
  } else if (platform === "darwin" || platform === "linux") {
    validateGuardianExecutable(
      stagedExecutable,
      `The ${platform} runtime process guardian`,
    );
  }

  const transactionId = randomUUID();
  const directory = transactionDirectory(stateDirectory, transactionId);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  syncDirectory(stateDirectory);
  const integrityStage = join(directory, "integrity.next");
  createDurableFile(
    integrityStage,
    `${JSON.stringify(
      {
        sha256: platform === "win32" ? expectedWindowsHash : null,
      },
      null,
      2,
    )}\n`,
    0o644,
  );

  const entries = [];
  const keys = ["guardian", "windowsJob", "integrity"];
  let journalWritten = false;
  try {
    for (const key of keys) {
      const metadata = validateExistingTarget(targets[key]);
      entries.push({
        existed: metadata !== null,
        key,
        mode: metadata ? metadata.mode & 0o777 : 0o644,
      });
      if (metadata) {
        copyFileSync(
          targets[key],
          join(directory, `${key}.backup`),
          constants.COPYFILE_EXCL,
        );
        syncFile(join(directory, `${key}.backup`));
      }
    }
    syncDirectory(directory);

    const journal = { entries, transactionId, version: 1 };
    const stagedJournal = join(
      stateDirectory,
      `.publication-journal.${transactionId}.tmp`,
    );
    createDurableFile(stagedJournal, `${JSON.stringify(journal)}\n`, 0o600);
    renameSync(stagedJournal, journalPath(stateDirectory));
    syncDirectory(stateDirectory);
    journalWritten = true;

    const desired =
      platform === "win32"
        ? [null, stagedExecutable, integrityStage]
        : platform === "darwin" || platform === "linux"
          ? [stagedExecutable, null, integrityStage]
          : [null, null, integrityStage];
    for (const [index, key] of keys.entries()) {
      const staged = desired[index];
      if (staged) {
        chmodSync(staged, key === "guardian" ? 0o755 : 0o644);
        syncFile(staged);
        renameSync(staged, targets[key]);
      } else {
        rmSync(targets[key], { force: true });
      }
      if (failAfterOperation === index + 1) {
        throw new Error("Injected runtime guardian publication failure.");
      }
    }
    for (const directoryPath of new Set(Object.values(targets).map(dirname))) {
      syncDirectory(directoryPath);
    }
    validateGuardianArtifactSet(platform, targets, expectedWindowsHash);
    rmSync(journalPath(stateDirectory), { force: true });
    syncDirectory(stateDirectory);
    journalWritten = false;
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if (journalWritten) {
      try {
        restoreTransaction(stateDirectory, targets, {
          entries,
          transactionId,
          version: 1,
        });
      } catch (rollbackError) {
        if (stagedExecutable) rmSync(stagedExecutable, { force: true });
        throw new AggregateError(
          [error, rollbackError],
          "Runtime guardian publication and rollback both failed.",
        );
      }
    } else {
      rmSync(directory, { recursive: true, force: true });
    }
    if (stagedExecutable) rmSync(stagedExecutable, { force: true });
    throw error;
  }
}
