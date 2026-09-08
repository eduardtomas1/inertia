import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

export async function privateText(path, maximum, proc = false) {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && (proc || metadata.uid === process.getuid()) && metadata.size <= maximum);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    assert(opened.dev === metadata.dev && opened.ino === metadata.ino && opened.size <= maximum);
    const bytes = Buffer.alloc(maximum + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    assert(bytesRead <= maximum);
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally { await file.close(); }
}

export async function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1);
  const directory = `/proc/${pid}`;
  try {
    const status = await privateText(join(directory, "status"), 4096, true);
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+/mu.exec(status);
    assert(uid && Number(uid[1]) === process.getuid() && Number(uid[2]) === process.getuid());
    const stat = await privateText(join(directory, "stat"), 4096, true);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
    if (["Z", "X"].includes(fields[0])) return null;
    assert.match(fields[19], /^[0-9]+$/u);
    const parentPid = Number(fields[1]);
    assert(Number.isSafeInteger(parentPid) && parentPid >= 0);
    return { pid, parentPid, start: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

export async function exactOwner(identity, guardian) {
  const current = await processIdentity(identity.pid);
  assert(current && current.start === identity.start);
  const seen = new Set([identity.pid]);
  let parent = current.parentPid;
  for (let depth = 0; depth < 32; depth++) {
    if (parent === guardian.pid) {
      const actual = await processIdentity(parent);
      assert(actual && actual.start === guardian.start);
      return current;
    }
    assert(parent > 1 && !seen.has(parent));
    seen.add(parent);
    const value = await processIdentity(parent);
    assert(value);
    parent = value.parentPid;
  }
  throw new Error("Owned ancestor could not be confirmed.");
}

export async function profileDirectory(root) {
  const matches = [];
  for (const name of ["inertia", "Inertia"]) {
    const directory = join(root, "config", name);
    const metadata = await lstat(directory).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) continue;
    assert(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === process.getuid());
    assert.equal(await realpath(directory), directory);
    matches.push(directory);
  }
  assert.equal(matches.length, 1);
  return matches[0];
}

// Only four fixed, bounded runtime log leaves in the private synthetic profile.
// Their capability-free digest is verified; no raw log is copied to evidence.
export async function readyRuntime(profile, excludedPids, afterMs) {
  const records = [];
  for (const name of ["runtime.3.log", "runtime.2.log", "runtime.1.log", "runtime.log"]) {
    const text = await privateText(join(profile, "logs", "runtime", name), 256 * 1024).catch(error => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    for (const line of text.split("\n").filter(Boolean)) {
      assert(line.length <= 4096);
      let record;
      try { record = JSON.parse(line); } catch { continue; } // An append may be in flight.
      if (record.schemaVersion !== 1 || record.event !== "runtime.state" || record.phase !== "ready"
        || !Number.isSafeInteger(record.processId) || excludedPids.has(record.processId)
        || !Number.isFinite(Date.parse(record.at)) || Date.parse(record.at) < afterMs) continue;
      const { recordDigest, ...fields } = record;
      const canonical = Object.keys(fields).sort().map(key => [key, fields[key]]);
      // Keep the same canonical form as RuntimeDiagnostics.diagnosticRecordDigest.
      const digest = createHash("sha256").update(JSON.stringify(Object.fromEntries(canonical))).digest("hex");
      assert.equal(recordDigest, digest);
      records.push(record);
    }
  }
  const latest = records.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  if (!latest) return null;
  const runtime = await processIdentity(latest.processId);
  if (!runtime) return null;
  const main = await processIdentity(runtime.parentPid);
  return main ? { runtime, main } : null;
}

export async function ownedWindow(mode, owner, guardian, environment) {
  await exactOwner(owner, guardian);
  const result = spawnSync("/usr/bin/python3", [new URL("./linux-public-upgrade-window.py", import.meta.url).pathname,
    mode, String(owner.pid), owner.start, String(guardian.pid), guardian.start], {
    shell: false, env: environment, encoding: "utf8", timeout: 2000, maxBuffer: 4096,
  });
  assert(!result.error && result.status === 0 && result.signal === null, "The exact owned X11 window could not be controlled normally.");
  const evidence = JSON.parse(result.stdout);
  assert(evidence.windowCount === 1 || (mode === "find" && evidence.windowCount === 0));
  assert.equal(evidence.normalCloseRequested, mode === "close");
  if (mode === "find") await exactOwner(owner, guardian);
  return evidence.windowCount === 1 ? evidence : null;
}
