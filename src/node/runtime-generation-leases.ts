import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "./runtime-process-protocol.js";

const MAX_GENERATION_LEASES = 32;
const LEASE_DIRECTORY = ".runtime-generation-leases";

export interface RuntimeGenerationLease {
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
  readonly createdAt: string;
}

function leaseName(runtimeGenerationId: string): string {
  return `${createHash("sha256").update(runtimeGenerationId).digest("hex")}.json`;
}

function leaseDirectory(dataDirectory: string): string {
  return join(dataDirectory, LEASE_DIRECTORY);
}

function fsyncDirectory(directory: string): void {
  try {
    const handle = openSync(directory, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
  } catch { /* Windows does not expose directory fsync. */ }
}

function validLease(
  value: unknown,
  expectedName: string,
): value is RuntimeGenerationLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Partial<RuntimeGenerationLease>;
  return validRuntimeGenerationId(lease.runtimeGenerationId)
    && validSystemBootId(lease.systemBootId)
    && typeof lease.createdAt === "string"
    && Number.isFinite(Date.parse(lease.createdAt))
    && leaseName(lease.runtimeGenerationId) === expectedName;
}

function parseLease(
  path: string,
  expectedName?: string,
): RuntimeGenerationLease | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512) {
      return null;
    }
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const generationId = (value as { runtimeGenerationId?: unknown }).runtimeGenerationId;
    if (typeof generationId !== "string") return null;
    const name = expectedName ?? leaseName(generationId);
    return validLease(value, name) ? value : null;
  } catch {
    return null;
  }
}

function readGenerationLeases(dataDirectory: string): RuntimeGenerationLease[] {
  const directory = leaseDirectory(dataDirectory);
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory);
  if (names.length > MAX_GENERATION_LEASES * 3) {
    throw new Error("The runtime generation lease storage bound was exceeded.");
  }
  const leases: RuntimeGenerationLease[] = [];
  for (const name of names) {
    const transient = name.match(
      /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(tmp|consume)$/iu,
    );
    if (transient) {
      const path = join(directory, name);
      const lease = parseLease(path);
      if (!lease) throw new Error("A runtime generation lease transient is invalid.");
      if (transient[1] === "tmp") {
        const expectedName = leaseName(lease.runtimeGenerationId);
        const target = join(directory, expectedName);
        if (existsSync(target)) {
          const published = parseLease(target, expectedName);
          if (
            !published
            || published.runtimeGenerationId !== lease.runtimeGenerationId
            || published.systemBootId !== lease.systemBootId
          ) throw new Error("A runtime generation lease transient conflicts.");
        }
      }
      try {
        unlinkSync(path);
        fsyncDirectory(directory);
      } catch {
        throw new Error("A runtime generation lease transient could not be retired.");
      }
      continue;
    }
    if (!/^[0-9a-f]{64}\.json$/u.test(name)) {
      throw new Error("Runtime generation lease storage contains a foreign entry.");
    }
    const lease = parseLease(join(directory, name), name);
    if (!lease) throw new Error("A runtime generation lease is invalid.");
    leases.push(lease);
    if (leases.length > MAX_GENERATION_LEASES) {
      throw new Error("The runtime generation lease bound was exceeded.");
    }
  }
  return leases.sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.runtimeGenerationId.localeCompare(right.runtimeGenerationId)
  ));
}

function publishGenerationLease(
  dataDirectory: string,
  lease: RuntimeGenerationLease,
): boolean {
  const expectedName = leaseName(lease.runtimeGenerationId);
  if (!validLease(lease, expectedName)) return false;
  let temporary: string | null = null;
  try {
    const directory = leaseDirectory(dataDirectory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, expectedName);
    if (existsSync(target)) {
      const current = parseLease(target, expectedName);
      return current?.runtimeGenerationId === lease.runtimeGenerationId
        && current.systemBootId === lease.systemBootId;
    }
    if (readGenerationLeases(dataDirectory).length >= MAX_GENERATION_LEASES) {
      return false;
    }
    temporary = join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(lease), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    chmodSync(temporary, 0o600);
    linkSync(temporary, target);
    unlinkSync(temporary);
    temporary = null;
    fsyncDirectory(directory);
    return true;
  } catch {
    if (temporary) {
      try { unlinkSync(temporary); } catch { /* Nothing was admitted. */ }
    }
    return false;
  }
}

function consumeGenerationLease(
  dataDirectory: string,
  runtimeGenerationId: string,
): boolean {
  const directory = leaseDirectory(dataDirectory);
  const expectedName = leaseName(runtimeGenerationId);
  const target = join(directory, expectedName);
  const quarantine = join(directory, `.${randomUUID()}.consume`);
  try {
    renameSync(target, quarantine);
    const stored = parseLease(quarantine, expectedName);
    if (!stored || stored.runtimeGenerationId !== runtimeGenerationId) {
      try { linkSync(quarantine, target); } catch { /* Preserve foreign bytes. */ }
      return false;
    }
    unlinkSync(quarantine);
    fsyncDirectory(directory);
    return true;
  } catch {
    return false;
  }
}

export class RuntimeGenerationLeaseJournal {
  private invalid = false;
  private leases = new Map<string, RuntimeGenerationLease>();

  constructor(private readonly dataDirectory: string) {
    this.refresh();
  }

  refresh(): void {
    try {
      const leases = readGenerationLeases(this.dataDirectory);
      this.leases = new Map(leases.map((lease) => [lease.runtimeGenerationId, lease]));
      if (this.leases.size !== leases.length) {
        throw new Error("A runtime generation lease identity is duplicated.");
      }
      this.invalid = false;
    } catch {
      this.invalid = true;
    }
  }

  isValid(): boolean { return !this.invalid; }
  all(): RuntimeGenerationLease[] { return [...this.leases.values()]; }
  safetyLocked(): boolean { return this.invalid || this.leases.size > 0; }

  publish(runtimeGenerationId: string, systemBootId: string): boolean {
    if (this.invalid) return false;
    const current = this.leases.get(runtimeGenerationId);
    if (current && current.systemBootId !== systemBootId) return false;
    const lease: RuntimeGenerationLease = current ?? {
      runtimeGenerationId,
      systemBootId,
      createdAt: new Date().toISOString(),
    };
    if (!publishGenerationLease(this.dataDirectory, lease)) return false;
    this.leases.set(runtimeGenerationId, lease);
    return true;
  }

  consume(runtimeGenerationId: string): boolean {
    if (this.invalid || !this.leases.has(runtimeGenerationId)) return false;
    if (!consumeGenerationLease(this.dataDirectory, runtimeGenerationId)) return false;
    this.leases.delete(runtimeGenerationId);
    return true;
  }

  clearRuntimeGeneration(runtimeGenerationId: string): boolean {
    if (this.invalid) return false;
    return !this.leases.has(runtimeGenerationId)
      || this.consume(runtimeGenerationId);
  }

  clearPriorBootSessions(systemBootId: string): boolean {
    if (this.invalid || !validSystemBootId(systemBootId)) return false;
    if (systemBootId === "unavailable") return true;
    return this.all()
      .filter((lease) => (
        lease.systemBootId !== "unavailable"
        && lease.systemBootId !== systemBootId
      ))
      .every((lease) => this.consume(lease.runtimeGenerationId));
  }
}
