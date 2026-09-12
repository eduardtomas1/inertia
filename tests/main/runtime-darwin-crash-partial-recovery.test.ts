import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareModernDarwinBootstrapRecovery } from "../../src/main/runtime-bootstrap-safety";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-process-journal";
import {
  runtimeOwnedProcessSessionName,
  runtimeOwnedProcessWriterName,
} from "../../src/node/runtime-owned-process-session-journal";

const generationId = "30000000-0000-4000-8000-000000000003:32";
const bootId = "test:00000000-0000-4000-8000-000000000001";
const guardianPath = "/private/tmp/inertia-test-guardian";
const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(recordedBootId = bootId) {
  const root = mkdtempSync(join(tmpdir(), "inertia-darwin-crash-partial-"));
  directories.push(root);
  const journal = new RuntimeOwnedProcessJournal(root, {
    platform: "darwin", darwinGuardianPath: guardianPath,
  });
  expect(new RuntimeGenerationLeaseJournal(root).publish(generationId, recordedBootId)).toBe(true);
  expect(journal.startSession(generationId, recordedBootId)).toBe(true);
  const capability = journal.sessionCapability(generationId, recordedBootId)!;
  const recover = () => prepareModernDarwinBootstrapRecovery(root, bootId,
    guardianPath, { platform: "darwin", deadlineAt: Date.now() + 100 });
  return { root, journal, capability, recover };
}

describe("exited Darwin generation crash-partial recovery", () => {
  it.each(["begin", "claim", "retire"] as const)(
    "offers consent after fencing an interrupted %s write without losing committed claims",
    async (phase) => {
      const { root, journal, capability, recover } = fixture();
      const ownershipId = phase === "begin"
        ? "40000000-0000-4000-8000-000000000004"
        : journal.begin(generationId, bootId, capability);
      if (phase === "retire") {
        journal.claim(ownershipId, generationId, bootId, 12345, process.pid, {
          observedDarwinIdentity: {
            platform: "darwin", pid: 12345, parentPid: process.pid,
            processGroupId: 12345, sessionId: 12345,
            startTimeSeconds: "1700000000", startTimeMicroseconds: 100,
          },
        });
      }
      const committed = journal.records(generationId);
      writeFileSync(join(root, runtimeOwnedProcessWriterName(generationId),
        `.runtime-owned-child-${ownershipId}.${phase}.tmp`), '{"state":', { mode: 0o600 });
      expect(journal.records(generationId)).toBeNull();

      const result = await recover();

      expect(result.blocked).toBe(false);
      expect(result.authority).toBeNull();
      expect(result.candidate?.generations).toHaveLength(1);
      expect(result.candidate?.generations[0]?.records).toEqual(committed);
      expect(journal.records(generationId)).toEqual(committed);
      expect(journal.sessionCapabilityCurrent(capability)).toBe(false);
    },
  );

  it.each(["malformed", "foreign-generation", "foreign-boot"] as const)(
    "keeps a %s committed claim safety locked and unchanged",
    async (kind) => {
      const { root, journal, capability, recover } = fixture();
      const ownershipId = journal.begin(generationId, bootId, capability);
      const path = join(root, `.runtime-owned-child-${ownershipId}.json`);
      const record = journal.records(generationId)![0]!;
      const bytes = kind === "malformed" ? '{"state":' : JSON.stringify({
        ...record,
        ...(kind === "foreign-generation"
          ? { runtimeGenerationId: "40000000-0000-4000-8000-000000000004:1" }
          : { systemBootId: "test:50000000-0000-4000-8000-000000000005" }),
      });
      writeFileSync(path, bytes, { mode: 0o600 });

      expect(await recover()).toEqual({ authority: null, candidate: null, blocked: true });
      expect(readFileSync(path, "utf8")).toBe(bytes);
    },
  );

  it("retains an unavailable boot identity while recovering its exact modern session", async () => {
    const { root, journal, recover } = fixture("unavailable");
    writeFileSync(join(root, runtimeOwnedProcessWriterName(generationId),
      ".runtime-owned-child-40000000-0000-4000-8000-000000000004.begin.tmp"), "{", { mode: 0o600 });
    expect(journal.records(generationId)).toBeNull();

    const result = await recover();

    expect(result.blocked).toBe(false);
    expect(result.authority).toBeNull();
    expect(result.candidate?.generations[0]?.lease.systemBootId).toBe("unavailable");
    expect(result.candidate?.generations[0]?.records).toEqual([]);
  });

  it("does not fence a session whose canonical name has a foreign generation identity", async () => {
    const { root, capability, recover } = fixture();
    const path = join(root, runtimeOwnedProcessSessionName(generationId));
    const bytes = JSON.stringify({
      ...capability.session, runtimeGenerationId: "40000000-0000-4000-8000-000000000004:1",
    });
    writeFileSync(path, bytes, { mode: 0o600 });

    expect(await recover()).toEqual({ authority: null, candidate: null, blocked: true });
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });
});
