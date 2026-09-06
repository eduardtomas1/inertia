import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const { boot } = vi.hoisted(() => ({ boot: vi.fn<() => string | null>() }));
vi.mock("../../src/main/system-boot-id", () => ({ readSystemBootId: boot }));

import { prepareRuntimeBootstrapSafety, runtimeBootstrapAdmissionBlocked } from "../../src/main/runtime-bootstrap-safety";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  boot.mockReset();
});

it.each(["win32", "darwin", "linux"] as const)(
  "retains a stranded %s profile until the system proves a different boot",
  (platform) => {
    const root = mkdtempSync(join(tmpdir(), "inertia-stranded-boot-"));
    roots.push(root);
    const generation = "30000000-0000-4000-8000-000000000003:50";
    const oldBoot = "test:00000000-0000-4000-8000-000000000001";
    const nextBoot = "test:00000000-0000-4000-8000-000000000002";
    expect(new RuntimeGenerationLeaseJournal(root).publish(generation, oldBoot)).toBe(true);
    const savedWork = Buffer.from("saved application data is not a cleanup journal");
    writeFileSync(join(root, "saved-work"), savedWork);
    const before = readdirSync(root).sort().map((name) => [name, readFileSync(join(root, name))]);

    for (const observed of [oldBoot, null, oldBoot]) {
      boot.mockReturnValue(observed);
      const safety = prepareRuntimeBootstrapSafety(root, platform);
      expect(safety.legacyRecoveryCandidates).toEqual([]);
      expect(safety.preserveAttachments).toBe(true);
      expect(runtimeBootstrapAdmissionBlocked(root, safety.systemBootId, platform)).toBe(true);
      expect(readdirSync(root).sort().map((name) => [name, readFileSync(join(root, name))]))
        .toEqual(before);
    }

    boot.mockReturnValue(nextBoot);
    const safety = prepareRuntimeBootstrapSafety(root, platform);
    expect(safety).toEqual({ systemBootId: nextBoot, preserveAttachments: false, legacyRecoveryCandidates: [] });
    expect(runtimeBootstrapAdmissionBlocked(root, nextBoot, platform)).toBe(false);
    expect(new RuntimeGenerationLeaseJournal(root).all()).toEqual([]);
    expect(readFileSync(join(root, "saved-work"))).toEqual(savedWork);
  },
);
