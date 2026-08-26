import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const bootProbe = vi.hoisted(() => ({
  calls: 0,
  startedAtMs: null as number | null,
}));

vi.mock("../../src/main/system-boot-id", () => ({
  readSystemBootId: () => "test:00000000-0000-4000-8000-000000000001",
  readSystemBootStartedAtMs: () => {
    bootProbe.calls += 1;
    return bootProbe.startedAtMs;
  },
}));

import { prepareRuntimeBootstrapSafety } from "../../src/main/runtime-bootstrap-safety";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";

const directories: string[] = [];

afterEach(() => {
  bootProbe.calls = 0;
  bootProbe.startedAtMs = null;
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runtime bootstrap safety", () => {
  it("creates a fresh profile data directory before opening its journals", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "fresh", "runtime");
    directories.push(root);
    expect(existsSync(dataDirectory)).toBe(false);

    expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: false,
    });
    expect(lstatSync(dataDirectory).isDirectory()).toBe(true);
    expect(bootProbe.calls).toBe(0);
  });

  it("retires a stale safety lease after proving the machine already rebooted", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const staleGenerationId = "30000000-0000-4000-8000-000000000003:8";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    const ownedProcesses = new RuntimeOwnedProcessJournal(dataDirectory);
    expect(leases.publish(staleGenerationId, "unavailable")).toBe(true);
    expect(ownedProcesses.startSession(
      staleGenerationId,
      "unavailable",
    )).toBe(true);
    ownedProcesses.begin(staleGenerationId, "unavailable");
    bootProbe.startedAtMs = Date.now() + 120_000;

    expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
      systemBootId: bootId,
      preserveAttachments: false,
    });
    expect(bootProbe.calls).toBe(1);
    leases.refresh();
    expect(leases.all()).toEqual([]);
    expect(ownedProcesses.records(staleGenerationId)).toBeNull();
  });

  it("never treats a current-boot lease as reboot-retired from timestamps alone", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const activeGenerationId = "30000000-0000-4000-8000-000000000003:10";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(activeGenerationId, bootId)).toBe(true);
    bootProbe.startedAtMs = Date.now() + 1_000;

    expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
      systemBootId: bootId,
      preserveAttachments: true,
    });
    expect(bootProbe.calls).toBe(0);
    leases.refresh();
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: activeGenerationId, systemBootId: bootId },
    ]);
  });

  it("keeps a legacy unavailable lease locked when boot-time proof is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const activeGenerationId = "30000000-0000-4000-8000-000000000003:11";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(activeGenerationId, "unavailable")).toBe(true);

    expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: true,
    });
    expect(bootProbe.calls).toBe(1);
    leases.refresh();
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: activeGenerationId, systemBootId: "unavailable" },
    ]);
  });

  it.runIf(process.platform === "linux")(
    "retires prior-boot ownership records before clearing their lease",
    () => {
      const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
      const dataDirectory = join(root, "runtime");
      const runtimeGenerationId =
        "30000000-0000-4000-8000-000000000003:9";
      const priorBootId = "test:10000000-0000-4000-8000-000000000001";
      directories.push(root);
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

      const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
      const ownedProcesses = new RuntimeOwnedProcessJournal(dataDirectory);
      expect(leases.publish(runtimeGenerationId, priorBootId)).toBe(true);
      expect(ownedProcesses.startSession(
        runtimeGenerationId,
        priorBootId,
      )).toBe(true);
      ownedProcesses.begin(runtimeGenerationId, priorBootId);

      expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        preserveAttachments: false,
      });
      leases.refresh();
      expect(leases.all()).toEqual([]);
      expect(ownedProcesses.records(runtimeGenerationId)).toBeNull();
      expect(readdirSync(dataDirectory).some((name) =>
        name.startsWith(".runtime-owned-"))).toBe(false);
    },
  );
});
