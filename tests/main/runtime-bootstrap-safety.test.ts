import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { readSystemBootIdMock } = vi.hoisted(() => ({
  readSystemBootIdMock: vi.fn(
    () => "test:00000000-0000-4000-8000-000000000001" as string | null,
  ),
}));
vi.mock("../../src/main/system-boot-id", () => ({
  readSystemBootId: readSystemBootIdMock,
}));

import {
  authorizeModernDarwinRuntimeRecovery,
  authorizeLegacyRuntimeRecovery,
  LEGACY_RUNTIME_RECOVERY_DIALOG_DETAIL,
  MODERN_DARWIN_RECOVERY_DIALOG_DETAIL,
  prepareModernDarwinBootstrapRecovery,
  prepareRuntimeBootstrapSafety,
  runtimeBootstrapAdmissionBlocked,
} from "../../src/main/runtime-bootstrap-safety";
import { RuntimeCleanupReceiptJournal } from
  "../../src/main/runtime-cleanup-receipts";
import {
  captureModernDarwinRecoverySnapshot,
  ModernDarwinRecoveryAuthorityJournal,
} from "../../src/node/runtime-modern-recovery-authorities";
import { LegacyRuntimeRecoveryAuthorityJournal } from "../../src/main/runtime-legacy-recovery-authorities";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
import {
  createDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalChildRoot,
  pinDirectRuntimeJournalRoot,
  readDirectRuntimeJournalLeaf,
  removeDirectRuntimeJournalChildRoot,
  renameDirectRuntimeJournalChildRoot,
  renameDirectRuntimeJournalLeaf,
} from "../../src/node/direct-runtime-journal";
import {
  runtimeOwnedProcessRetiringSessionName,
  runtimeOwnedProcessRetiringWriterName,
  runtimeOwnedProcessSessionName,
  runtimeOwnedProcessWriterName,
} from
  "../../src/node/runtime-owned-process-session-journal";

const directories: string[] = [];

afterEach(() => {
  readSystemBootIdMock.mockReturnValue(
    "test:00000000-0000-4000-8000-000000000001",
  );
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runtime bootstrap safety", () => {
  it("asks only for visible old processes and never requires a reboot or hidden helper", () => {
    for (const detail of [
      MODERN_DARWIN_RECOVERY_DIALOG_DETAIL,
      LEGACY_RUNTIME_RECOVERY_DIALOG_DETAIL,
    ]) {
      expect(detail).toMatch(/will NOT kill any surviving process/u);
      expect(detail).toMatch(/older Inertia window/u);
      expect(detail).toMatch(/agent or terminal process.*you can still see/u);
      expect(detail).not.toMatch(/reboot|restart|guardian|helper/iu);
    }
    expect(MODERN_DARWIN_RECOVERY_DIALOG_DETAIL)
      .toMatch(/exact recorded roots and state.*checked again/u);
  });

  it("creates a fresh profile data directory before opening its journals", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "fresh", "runtime");
    directories.push(root);
    expect(existsSync(dataDirectory)).toBe(false);

    expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: false,
      legacyRecoveryCandidates: [],
    });
    expect(lstatSync(dataDirectory).isDirectory()).toBe(true);
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "repairs an exact empty %s writer crash prefix only during bootstrap",
    (platform) => {
      const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
      const dataDirectory = join(root, "runtime");
      const generationId = "30000000-0000-4000-8000-000000000003:91";
      directories.push(root);
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      const journalRoot = pinDirectRuntimeJournalRoot(dataDirectory);
      const writerName = runtimeOwnedProcessWriterName(generationId);
      expect(createDirectRuntimeJournalChildRoot(
        journalRoot,
        writerName,
      )).not.toBeNull();
      const ordinaryReader = new RuntimeOwnedProcessJournal(dataDirectory, {
        platform,
      });
      expect(ordinaryReader.inspectGeneration(generationId)).toBeNull();
      expect(pinDirectRuntimeJournalChildRoot(journalRoot, writerName))
        .not.toBeNull();

      expect(prepareRuntimeBootstrapSafety(dataDirectory, platform)).toEqual({
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        preserveAttachments: false,
        legacyRecoveryCandidates: [],
      });
      expect(pinDirectRuntimeJournalChildRoot(journalRoot, writerName))
        .toBeNull();
    },
  );

  it.each(["darwin", "linux", "win32"] as const)(
    "retires an empty unleased %s session left before admission completed",
    (platform) => {
      const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
      const dataDirectory = join(root, "runtime");
      const generationId = "30000000-0000-4000-8000-000000000003:92";
      directories.push(root);
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      const owned = new RuntimeOwnedProcessJournal(dataDirectory, { platform });
      expect(owned.startSession(
        generationId,
        "test:00000000-0000-4000-8000-000000000001",
      )).toBe(true);

      expect(prepareRuntimeBootstrapSafety(dataDirectory, platform)).toEqual({
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        preserveAttachments: false,
        legacyRecoveryCandidates: [],
      });
      expect(owned.inspectGeneration(generationId)).toMatchObject({
        session: null,
        records: [],
        consumingRecords: [],
      });
    },
  );

  it.each(
    (["darwin", "linux", "win32"] as const).flatMap((platform) =>
      (["writer-renamed", "session-renamed", "writer-removed"] as const)
        .map((stage) => [platform, stage] as const)),
  )("replays an unleased empty %s retirement after %s", (platform, stage) => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:94";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, { platform });
    expect(owned.startSession(generationId, bootId)).toBe(true);
    const journalRoot = pinDirectRuntimeJournalRoot(dataDirectory);
    const activeWriterName = runtimeOwnedProcessWriterName(generationId);
    const retiringWriterName = runtimeOwnedProcessRetiringWriterName(
      generationId,
    );
    const activeWriter = pinDirectRuntimeJournalChildRoot(
      journalRoot,
      activeWriterName,
    )!;
    const retiringWriter = renameDirectRuntimeJournalChildRoot(
      journalRoot,
      activeWriterName,
      retiringWriterName,
      activeWriter,
    )!;
    expect(retiringWriter).not.toBeNull();
    if (stage !== "writer-renamed") {
      const sessionName = runtimeOwnedProcessSessionName(generationId);
      const session = readDirectRuntimeJournalLeaf(
        journalRoot,
        sessionName,
        768,
      )!;
      expect(renameDirectRuntimeJournalLeaf(
        journalRoot,
        sessionName,
        runtimeOwnedProcessRetiringSessionName(generationId),
        session.identity,
      )).toBe(true);
    }
    if (stage === "writer-removed") {
      expect(removeDirectRuntimeJournalChildRoot(
        journalRoot,
        retiringWriterName,
        retiringWriter,
      )).toBe(true);
    }

    expect(prepareRuntimeBootstrapSafety(dataDirectory, platform)).toEqual({
      systemBootId: bootId,
      preserveAttachments: false,
      legacyRecoveryCandidates: [],
    });
    expect(owned.inspectGeneration(generationId)).toMatchObject({
      session: null,
      records: [],
      consumingRecords: [],
    });
  });

  it.each(["malformed-canonical", "foreign-name"] as const)(
    "does not mutate an empty session when lease storage is %s",
    (leaseFailure) => {
      const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
      const dataDirectory = join(root, "runtime");
      const generationId = "30000000-0000-4000-8000-000000000003:95";
      const bootId = "test:00000000-0000-4000-8000-000000000001";
      directories.push(root);
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      });
      expect(owned.startSession(generationId, bootId)).toBe(true);
      const leaseName = leaseFailure === "malformed-canonical"
        ? `.runtime-generation-lease-${createHash("sha256")
          .update(generationId).digest("hex")}.json`
        : ".runtime-generation-lease-foreign.json";
      writeFileSync(join(dataDirectory, leaseName), "{", { mode: 0o600 });
      const entriesBefore = readdirSync(dataDirectory).sort();

      expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin"))
        .toMatchObject({ preserveAttachments: true });
      expect(readdirSync(dataDirectory).sort()).toEqual(entriesBefore);
      expect(owned.inspectGeneration(generationId)).toMatchObject({
        session: { runtimeGenerationId: generationId, systemBootId: bootId },
        sessionState: "active",
        sessionWriterPresent: true,
        records: [],
        consumingRecords: [],
        containment: null,
      });
    },
  );

  it("keeps a state-bearing unleased session safety locked", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:93";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    });
    expect(owned.startSession(generationId, bootId)).toBe(true);
    const ownershipId = owned.begin(
      generationId,
      bootId,
      owned.sessionCapability(generationId, bootId)!,
    );

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin"))
      .toMatchObject({ preserveAttachments: true });
    expect(owned.records(generationId)).toEqual([
      expect.objectContaining({ ownershipId, state: "pending" }),
    ]);
  });

  it("never retires an unavailable lease from historical wall-clock state", () => {
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
    ownedProcesses.begin(
      staleGenerationId,
      "unavailable",
      ownedProcesses.sessionCapability(staleGenerationId, "unavailable")!,
    );
    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin")).toEqual({
      systemBootId: bootId,
      preserveAttachments: true,
      legacyRecoveryCandidates: [],
    });
    leases.refresh();
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: staleGenerationId, systemBootId: "unavailable" },
    ]);
    expect(ownedProcesses.records(staleGenerationId)).toHaveLength(1);
  });

  it("keeps a modern current-boot lease outside manual recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const activeGenerationId = "30000000-0000-4000-8000-000000000003:10";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(activeGenerationId, bootId)).toBe(true);
    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin")).toEqual({
      systemBootId: bootId,
      preserveAttachments: true,
      legacyRecoveryCandidates: [],
    });
    leases.refresh();
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: activeGenerationId, systemBootId: bootId },
    ]);
  });

  it("authorizes modern and unavailable legacy batches together in one launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const legacyGenerationId = "30000000-0000-4000-8000-000000000003:30";
    const exactGenerationId = "30000000-0000-4000-8000-000000000003:31";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(legacyGenerationId, "unavailable")).toBe(true);
    expect(leases.publish(exactGenerationId, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(exactGenerationId, bootId)).toBe(true);

    // The unrelated owned session initially suppresses the old broad legacy
    // eligibility check.
    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin")
      .legacyRecoveryCandidates).toEqual([]);
    const modern = await prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 1_000 },
    );
    expect(modern).toMatchObject({ authority: null, blocked: false });
    expect(modern.candidate?.generations).toHaveLength(1);
    const modernDescriptor = authorizeModernDarwinRuntimeRecovery(
      dataDirectory,
      modern.candidate!,
      bootId,
      "/private/tmp/inertia-test-guardian",
      {
        platform: "darwin",
        readDarwinIdentity: () => null,
        pidExists: () => false,
      },
    );
    expect(modernDescriptor).not.toBeNull();

    // Bootstrap re-reads safety only after the complete modern snapshot is
    // durable, then binds the independent legacy batch before supervisor
    // admission. Neither path needs a second restart.
    const preparedLegacy = prepareRuntimeBootstrapSafety(
      dataDirectory,
      "darwin",
    );
    expect(preparedLegacy.legacyRecoveryCandidates).toEqual([
      legacyGenerationId,
    ]);
    expect(authorizeLegacyRuntimeRecovery(
      dataDirectory,
      preparedLegacy.legacyRecoveryCandidates,
      bootId,
      "darwin",
    )).toBe(true);
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toMatchObject({ snapshotDigest: modernDescriptor?.snapshotDigest });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("darwin", bootId)).toEqual([legacyGenerationId]);
  });

  it("offers and binds only unchanged concrete-boot Darwin state", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:32";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
      darwinGuardianPath: "/private/tmp/inertia-test-guardian",
    });
    expect(owned.startSession(generationId, bootId)).toBe(true);
    owned.begin(
      generationId,
      bootId,
      owned.sessionCapability(generationId, bootId)!,
    );

    const prepared = await prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    );
    expect(prepared.blocked).toBe(false);
    expect(prepared.authority).toBeNull();
    expect(prepared.candidate?.generations).toHaveLength(1);
    const descriptor = authorizeModernDarwinRuntimeRecovery(
      dataDirectory,
      prepared.candidate!,
      bootId,
      "/private/tmp/inertia-test-guardian",
      {
        platform: "darwin",
        readDarwinIdentity: () => null,
        pidExists: () => false,
      },
    );
    expect(descriptor?.runtimeGenerationIds).toEqual([generationId]);
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toMatchObject({
        operationId: descriptor?.operationId,
        snapshotDigest: descriptor?.snapshotDigest,
      });
  });

  it("accepts exact Darwin retirement settling across durable journal steps", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:36";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(generationId, bootId)).toBe(true);

    let completeCleanup!: (completed: boolean) => void;
    const cleanup = new Promise<boolean>((resolve) => {
      completeCleanup = resolve;
    });
    queueMicrotask(() => {
      const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      });
      const receipts = new RuntimeCleanupReceiptJournal(dataDirectory);
      const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
      const sessionFinished = owned.finishSession(generationId);
      setTimeout(() => {
        const receiptPublished = receipts.publish(generationId);
        setTimeout(() => {
          completeCleanup(
            sessionFinished
            && receiptPublished
            && leases.clearRuntimeGeneration(generationId),
          );
        }, 20);
      }, 20);
    });

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: false,
    });
    await expect(cleanup).resolves.toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
    expect(readdirSync(dataDirectory).filter((name) =>
      name.startsWith(".runtime-owned-"))).toEqual([]);
  });

  it("finishes an exact receipt-backed Darwin lease without an app restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:39";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    });
    expect(leases.publish(generationId, bootId)).toBe(true);
    expect(owned.startSession(generationId, bootId)).toBe(true);
    expect(owned.finishSession(generationId)).toBe(true);
    expect(new RuntimeCleanupReceiptJournal(dataDirectory).publish(
      generationId,
    )).toBe(true);

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: false,
    });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
    expect(new RuntimeCleanupReceiptJournal(dataDirectory).pending())
      .toEqual([generationId]);
  });

  it("settles a receipt-backed retiring session in one bootstrap pass", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:41";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    });
    const receipts = new RuntimeCleanupReceiptJournal(dataDirectory);
    expect(leases.publish(generationId, bootId)).toBe(true);
    expect(owned.startSession(generationId, bootId)).toBe(true);
    expect(owned.finishSession(generationId, () => {
      expect(receipts.publish(generationId)).toBe(true);
      return false;
    })).toBe(false);

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin"))
      .toMatchObject({ preserveAttachments: false });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).sessionExact(generationId)).toBeNull();
    expect(new RuntimeCleanupReceiptJournal(dataDirectory).pending())
      .toEqual([generationId]);
  });

  it("blocks admission for a bare same-boot lease without amplifying state", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:42";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(prepareRuntimeBootstrapSafety(dataDirectory, "win32"))
        .toMatchObject({ preserveAttachments: true });
      expect(runtimeBootstrapAdmissionBlocked(dataDirectory)).toBe(true);
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
        .toEqual([expect.objectContaining({ runtimeGenerationId: generationId })]);
      expect(new RuntimeCleanupReceiptJournal(dataDirectory).pending()).toEqual([]);
    }
  });

  it("keeps entry-state partial Darwin retirement safety locked", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:40";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    });
    expect(owned.startSession(generationId, bootId)).toBe(true);
    expect(owned.finishSession(generationId)).toBe(true);

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: true,
    });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
      .toEqual([expect.objectContaining({ runtimeGenerationId: generationId })]);
    expect(new RuntimeCleanupReceiptJournal(dataDirectory).pending()).toEqual([]);
  });

  it("rejects an orphan Darwin owned-session leaf without a lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:41";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(generationId, bootId)).toBe(true);

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: true,
    });
  });

  it("does not bypass a partial generation beside an active Darwin candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const activeGeneration = "30000000-0000-4000-8000-000000000003:42";
    const partialGeneration = "30000000-0000-4000-8000-000000000003:43";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    });
    expect(leases.publish(activeGeneration, bootId)).toBe(true);
    expect(owned.startSession(activeGeneration, bootId)).toBe(true);
    expect(leases.publish(partialGeneration, bootId)).toBe(true);

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: true,
    });
    expect(captureModernDarwinRecoverySnapshot(dataDirectory, bootId)
      ?.generations.map(({ lease }) => lease.runtimeGenerationId))
      .toEqual([activeGeneration]);
  });

  it("rejects a lease published after Darwin recovery sampling begins", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const activeGeneration = "30000000-0000-4000-8000-000000000003:44";
    const concurrentGeneration = "30000000-0000-4000-8000-000000000003:45";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(activeGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(activeGeneration, bootId)).toBe(true);

    let concurrentLeasePublished = false;
    queueMicrotask(() => {
      concurrentLeasePublished = new RuntimeGenerationLeaseJournal(
        dataDirectory,
      ).publish(concurrentGeneration, bootId);
    });

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: true,
    });
    expect(concurrentLeasePublished).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()
      .map(({ runtimeGenerationId }) => runtimeGenerationId).sort())
      .toEqual([activeGeneration, concurrentGeneration]);
  });

  it("rejects a legacy lease disappearing during modern Darwin sampling", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const activeGeneration = "30000000-0000-4000-8000-000000000003:46";
    const legacyGeneration = "30000000-0000-4000-8000-000000000003:47";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(legacyGeneration, "unavailable")).toBe(true);
    expect(leases.publish(activeGeneration, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(activeGeneration, bootId)).toBe(true);

    let legacyLeaseRemoved = false;
    queueMicrotask(() => {
      legacyLeaseRemoved = new RuntimeGenerationLeaseJournal(
        dataDirectory,
      ).clearRuntimeGeneration(legacyGeneration);
    });

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: true,
    });
    expect(legacyLeaseRemoved).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()
      .map(({ runtimeGenerationId }) => runtimeGenerationId))
      .toEqual([activeGeneration]);
  });

  it("rejects Darwin journal disappearance without a cleanup receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:38";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(generationId, bootId)).toBe(true);

    let journalsRemoved = false;
    queueMicrotask(() => {
      const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      });
      const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
      journalsRemoved = owned.finishSession(generationId)
        && leases.clearRuntimeGeneration(generationId);
    });

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: true,
    });
    expect(journalsRemoved).toBe(true);
    expect(new RuntimeCleanupReceiptJournal(dataDirectory).pending()).toEqual([]);
  });

  it("keeps partial Darwin retirement safety locked", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:37";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(generationId, bootId)).toBe(true);

    let sessionRetired = false;
    queueMicrotask(() => {
      sessionRetired = new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      }).finishSession(generationId);
    });

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    )).resolves.toEqual({
      authority: null,
      candidate: null,
      blocked: true,
    });
    expect(sessionRetired).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
      .toEqual([expect.objectContaining({ runtimeGenerationId: generationId })]);
  });

  it("replays an acknowledged lease-free Darwin retirement before scanning current state", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const oldGeneration = "30000000-0000-4000-8000-000000000003:41";
    const currentGeneration = "30000000-0000-4000-8000-000000000003:42";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const guardianPath = "/private/tmp/inertia-test-guardian";
    const processIdentity = {
      platform: "darwin" as const,
      pid: 7_441,
      parentPid: 7_400,
      processGroupId: 7_441,
      sessionId: 7_441,
      startTimeSeconds: "1800000000",
      startTimeMicroseconds: 123_456,
    };
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(oldGeneration, bootId)).toBe(true);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
      darwinGuardianPath: guardianPath,
      readDarwinIdentity: () => processIdentity,
    });
    expect(owned.startSession(oldGeneration, bootId)).toBe(true);
    const ownershipId = owned.begin(
      oldGeneration,
      bootId,
      owned.sessionCapability(oldGeneration, bootId)!,
    );
    owned.claim(ownershipId, oldGeneration, bootId, 7_441, 7_400);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      bootId,
    )!;
    const authorities = new ModernDarwinRecoveryAuthorityJournal(
      dataDirectory,
    );
    expect(authorities.publish(snapshot)).not.toBeNull();
    const authority = authorities.pending()!;
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(owned.startSession(currentGeneration, bootId)).toBe(true);
    expect(authorities.beginRetirement(
      authority,
      dataDirectory,
      currentGeneration,
      {
        guardianPath,
        platform: "darwin",
        readDarwinIdentity: () => null,
        pidExists: () => false,
      },
    )).toBe(true);
    expect(leases.clearRuntimeGeneration(oldGeneration)).toBe(true);

    const replay = await prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      guardianPath,
      {
        platform: "darwin",
        readDarwinIdentity: () => null,
        pidExists: () => false,
      },
    );
    expect(replay.blocked).toBe(false);
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).retiring())
      .toBeNull();
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).records(oldGeneration)).toBeNull();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([
      expect.objectContaining({ runtimeGenerationId: currentGeneration }),
    ]);
  });

  it("replays the terminal retiring-session prefix after its writer was removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const oldGeneration = "30000000-0000-4000-8000-000000000003:94";
    const currentGeneration = "30000000-0000-4000-8000-000000000003:95";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const guardianPath = "/private/tmp/inertia-test-guardian";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(oldGeneration, bootId)).toBe(true);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    });
    expect(owned.startSession(oldGeneration, bootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      bootId,
    )!;
    const authorities = new ModernDarwinRecoveryAuthorityJournal(
      dataDirectory,
    );
    expect(authorities.publish(snapshot)).not.toBeNull();
    const authority = authorities.pending()!;
    expect(leases.publish(currentGeneration, bootId)).toBe(true);
    expect(owned.startSession(currentGeneration, bootId)).toBe(true);
    expect(authorities.beginRetirement(
      authority,
      dataDirectory,
      currentGeneration,
      {
        guardianPath,
        platform: "darwin",
        readDarwinIdentity: () => null,
        pidExists: () => false,
      },
    )).toBe(true);
    const oldSession = owned.inspectGeneration(oldGeneration)?.session;
    expect(oldSession).not.toBeNull();
    expect(owned.fenceSessionExact(oldSession!)).toBe(true);
    const journalRoot = pinDirectRuntimeJournalRoot(dataDirectory);
    const writerName = runtimeOwnedProcessRetiringWriterName(oldGeneration);
    const retiredWriter = pinDirectRuntimeJournalChildRoot(
      journalRoot,
      writerName,
    );
    expect(retiredWriter).not.toBeNull();
    expect(removeDirectRuntimeJournalChildRoot(
      journalRoot,
      writerName,
      retiredWriter!,
    )).toBe(true);

    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      guardianPath,
      {
        platform: "darwin",
        readDarwinIdentity: () => null,
        pidExists: () => false,
      },
    )).resolves.toMatchObject({ blocked: false });
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).retiring())
      .toBeNull();
    expect(owned.inspectGeneration(oldGeneration)).toMatchObject({
      session: null,
      records: [],
      consumingRecords: [],
    });
  });

  it("rejects confirmation while an exact recorded Darwin root is still alive", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:33";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const guardianIdentity = {
      platform: "darwin" as const,
      pid: 7_431,
      parentPid: 7_400,
      processGroupId: 7_431,
      sessionId: 7_431,
      startTimeSeconds: "1800000000",
      startTimeMicroseconds: 123_456,
    };
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
      readDarwinIdentity: () => guardianIdentity,
    });
    expect(owned.startSession(generationId, bootId)).toBe(true);
    const ownershipId = owned.begin(
      generationId,
      bootId,
      owned.sessionCapability(generationId, bootId)!,
    );
    owned.claim(ownershipId, generationId, bootId, 7_431, 7_400);
    const candidate = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      bootId,
    );
    expect(candidate).not.toBeNull();

    expect(authorizeModernDarwinRuntimeRecovery(
      dataDirectory,
      candidate!,
      bootId,
      "/private/tmp/inertia-test-guardian",
      {
        platform: "darwin",
        readDarwinIdentity: () => guardianIdentity,
        pidExists: () => true,
      },
    )).toBeNull();
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toBeNull();
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).records(generationId)).toHaveLength(1);
  });

  it("cancels a replayed authority when its exact guardian root is live again", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:35";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    const guardianIdentity = {
      platform: "darwin" as const,
      pid: 7_435,
      parentPid: 7_400,
      processGroupId: 7_435,
      sessionId: 7_435,
      startTimeSeconds: "1800000000",
      startTimeMicroseconds: 123_456,
    };
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      bootId,
    )).toBe(true);
    const owned = new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
      readDarwinIdentity: () => guardianIdentity,
    });
    expect(owned.startSession(generationId, bootId)).toBe(true);
    const ownershipId = owned.begin(
      generationId,
      bootId,
      owned.sessionCapability(generationId, bootId)!,
    );
    owned.claim(ownershipId, generationId, bootId, 7_435, 7_400);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      bootId,
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot && new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
      .publish(snapshot)).not.toBeNull();

    const replay = await prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      bootId,
      "/private/tmp/inertia-test-guardian",
      {
        platform: "darwin",
        deadlineAt: Date.now() + 100,
        readDarwinIdentity: () => guardianIdentity,
        pidExists: () => true,
      },
    );
    expect(replay.authority).toBeNull();
    expect(replay.candidate?.generations[0]?.records).toHaveLength(1);
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toBeNull();
  });

  it("cancels a pending modern authority after a verified boot change", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:34";
    const priorBootId = "test:10000000-0000-4000-8000-000000000001";
    const currentBootId = "test:20000000-0000-4000-8000-000000000002";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(generationId, priorBootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(generationId, priorBootId)).toBe(true);
    const snapshot = captureModernDarwinRecoverySnapshot(
      dataDirectory,
      priorBootId,
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot && new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
      .publish(snapshot)).not.toBeNull();
    readSystemBootIdMock.mockReturnValue(currentBootId);

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin")).toMatchObject({
      systemBootId: currentBootId,
      preserveAttachments: false,
    });
    await expect(prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      currentBootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin" },
    )).resolves.toEqual({ authority: null, candidate: null, blocked: false });
    expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
      .toBeNull();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
  });

  it("offers only an unowned legacy Windows or macOS lease for manual recovery", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const activeGenerationId = "30000000-0000-4000-8000-000000000003:11";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(activeGenerationId, "unavailable")).toBe(true);

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "win32")).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: true,
      legacyRecoveryCandidates: [activeGenerationId],
    });
    leases.refresh();
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: activeGenerationId, systemBootId: "unavailable" },
    ]);
  });

  it("retains the lease and re-prompts after an incomplete authority publish", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:16";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(generationId, "unavailable")).toBe(true);
    const generationHash = createHash("sha256")
      .update(generationId)
      .digest("hex");
    writeFileSync(
      join(
        dataDirectory,
        `.runtime-legacy-recovery-authority-${generationHash}.publish.tmp`,
      ),
      "{",
      { mode: 0o600 },
    );

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin")).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: true,
      legacyRecoveryCandidates: [generationId],
    });
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: generationId, systemBootId: "unavailable" },
    ]);
  });

  it("publishes an exact replayable authority without clearing the lease", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:12";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(generationId, "unavailable")).toBe(true);

    expect(authorizeLegacyRuntimeRecovery(
      dataDirectory,
      [generationId],
      bootId,
      "darwin",
    )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("darwin", bootId)).toEqual([generationId]);
    leases.refresh();
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: generationId, systemBootId: "unavailable" },
    ]);
    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin")).toEqual({
      systemBootId: bootId,
      preserveAttachments: true,
      legacyRecoveryCandidates: [],
    });
  });

  it("keeps an acknowledged current-boot authority for supervisor replay", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationIds = [
      "30000000-0000-4000-8000-000000000003:87",
      "30000000-0000-4000-8000-000000000003:88",
    ];
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    for (const generationId of generationIds) {
      expect(leases.publish(generationId, "unavailable")).toBe(true);
    }
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .publishBatch(generationIds, "win32", bootId)).toBe(true);
    for (const generationId of generationIds) {
      expect(leases.clearRuntimeGeneration(generationId)).toBe(true);
    }

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "win32")).toEqual({
      systemBootId: bootId,
      preserveAttachments: false,
      legacyRecoveryCandidates: [],
    });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("win32", bootId)).toEqual(generationIds);
  });

  it("authorizes an unowned Linux fallback lease without bypassing exact records", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:18";
    const bootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      "unavailable",
    )).toBe(true);

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "linux")
      .legacyRecoveryCandidates).toEqual([generationId]);
    expect(authorizeLegacyRuntimeRecovery(
      dataDirectory,
      [generationId],
      bootId,
      "linux",
    )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("linux", bootId)).toEqual([generationId]);
  });

  it("retires an expired authority but keeps its lease for fresh confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:14";
    const previousBootId = "test:10000000-0000-4000-8000-000000000001";
    const currentBootId = "test:00000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const leases = new RuntimeGenerationLeaseJournal(dataDirectory);
    expect(leases.publish(generationId, "unavailable")).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory).publish(
      generationId,
      "win32",
      previousBootId,
    )).toBe(true);

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "win32")).toEqual({
      systemBootId: currentBootId,
      preserveAttachments: true,
      legacyRecoveryCandidates: [generationId],
    });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("win32", previousBootId)).toEqual([]);
    expect(leases.all()).toMatchObject([
      { runtimeGenerationId: generationId, systemBootId: "unavailable" },
    ]);
    expect(authorizeLegacyRuntimeRecovery(
      dataDirectory,
      [generationId],
      currentBootId,
      "win32",
    )).toBe(true);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("win32", currentBootId)).toEqual([generationId]);
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("win32", previousBootId)).toEqual([]);
  });

  it("retires an expired authority only after its legacy lease is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:17";
    const previousBootId = "test:10000000-0000-4000-8000-000000000001";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory).publish(
      generationId,
      "darwin",
      previousBootId,
    )).toBe(true);

    expect(prepareRuntimeBootstrapSafety(dataDirectory, "darwin")).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: false,
      legacyRecoveryCandidates: [],
    });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
      .pending("darwin", previousBootId)).toEqual([]);
  });

  it.each(["win32", "darwin", "linux"] as const)(
    "offers exact no-reboot legacy recovery when the %s boot probe is unavailable",
    (platform) => {
      const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
      const dataDirectory = join(root, "runtime");
      const generationId = "30000000-0000-4000-8000-000000000003:15";
      directories.push(root);
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      expect(new RuntimeGenerationLeaseJournal(dataDirectory)
        .publish(generationId, "unavailable")).toBe(true);
    readSystemBootIdMock.mockReturnValue(null);

      expect(prepareRuntimeBootstrapSafety(dataDirectory, platform)).toEqual({
        systemBootId: "unavailable",
        preserveAttachments: true,
        legacyRecoveryCandidates: [generationId],
      });
      expect(authorizeLegacyRuntimeRecovery(
        dataDirectory,
        [generationId],
        "unavailable",
        platform,
      )).toBe(true);
      expect(new LegacyRuntimeRecoveryAuthorityJournal(dataDirectory)
        .pending(platform, "unavailable")).toEqual([generationId]);
    },
  );

  it("keeps probe-unavailable modern macOS state on the explicit recovery path", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const dataDirectory = join(root, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:19";
    const legacyGenerationId = "30000000-0000-4000-8000-000000000003:20";
    directories.push(root);
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      generationId,
      "unavailable",
    )).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      legacyGenerationId,
      "unavailable",
    )).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, {
      platform: "darwin",
    }).startSession(generationId, "unavailable")).toBe(true);
    readSystemBootIdMock.mockReturnValue(null);

    const safety = prepareRuntimeBootstrapSafety(dataDirectory, "darwin");
    expect(safety).toEqual({
      systemBootId: "unavailable",
      preserveAttachments: true,
      legacyRecoveryCandidates: [],
    });
    const prepared = await prepareModernDarwinBootstrapRecovery(
      dataDirectory,
      safety.systemBootId,
      "/private/tmp/inertia-test-guardian",
      { platform: "darwin", deadlineAt: Date.now() + 100 },
    );
    expect(prepared).toMatchObject({ authority: null, blocked: false });
    expect(prepared.candidate).toMatchObject({
      platform: "darwin",
      systemBootId: "unavailable",
      generations: [{
        lease: { runtimeGenerationId: generationId },
        records: [],
      }],
    });
    const descriptor = authorizeModernDarwinRuntimeRecovery(
      dataDirectory,
      prepared.candidate!,
      safety.systemBootId,
      "/private/tmp/inertia-test-guardian",
      {
        platform: "darwin",
        readDarwinIdentity: () => null,
        pidExists: () => false,
      },
    );
    expect(descriptor?.runtimeGenerationIds).toEqual([generationId]);
    const afterModernAuthority = prepareRuntimeBootstrapSafety(
      dataDirectory,
      "darwin",
    );
    expect(afterModernAuthority.legacyRecoveryCandidates).toEqual([
      legacyGenerationId,
    ]);
    expect(authorizeLegacyRuntimeRecovery(
      dataDirectory,
      afterModernAuthority.legacyRecoveryCandidates,
      "unavailable",
      "darwin",
    )).toBe(true);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all())
      .toContainEqual(expect.objectContaining({
        runtimeGenerationId: generationId,
        systemBootId: "unavailable",
      }));
  });

  it.each([
    [
      "unavailable",
      "test:00000000-0000-4000-8000-000000000001",
    ],
    [
      "test:00000000-0000-4000-8000-000000000001",
      "unavailable",
    ],
  ] as const)(
    "re-prompts modern macOS recovery when the boot probe changes from %s to %s",
    async (recordedBootId, observedBootId) => {
      const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
      const dataDirectory = join(root, "runtime");
      const generationId = "30000000-0000-4000-8000-000000000003:21";
      directories.push(root);
      mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
      expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
        generationId,
        recordedBootId,
      )).toBe(true);
      expect(new RuntimeOwnedProcessJournal(dataDirectory, {
        platform: "darwin",
      }).startSession(generationId, recordedBootId)).toBe(true);

      const initialSnapshot = captureModernDarwinRecoverySnapshot(
        dataDirectory,
        recordedBootId,
      );
      expect(initialSnapshot).not.toBeNull();
      expect(initialSnapshot
        && new ModernDarwinRecoveryAuthorityJournal(dataDirectory)
          .publish(initialSnapshot)).not.toBeNull();

      const prepared = await prepareModernDarwinBootstrapRecovery(
        dataDirectory,
        observedBootId,
        "/private/tmp/inertia-test-guardian",
        { platform: "darwin", deadlineAt: Date.now() + 100 },
      );
      expect(prepared).toMatchObject({ authority: null, blocked: false });
      expect(prepared.candidate).toMatchObject({
        systemBootId: observedBootId,
        generations: [{
          lease: {
            runtimeGenerationId: generationId,
            systemBootId: recordedBootId,
          },
        }],
      });
      expect(new ModernDarwinRecoveryAuthorityJournal(dataDirectory).pending())
        .toBeNull();
      expect(authorizeModernDarwinRuntimeRecovery(
        dataDirectory,
        prepared.candidate!,
        observedBootId,
        "/private/tmp/inertia-test-guardian",
        {
          platform: "darwin",
          readDarwinIdentity: () => null,
          pidExists: () => false,
        },
      )?.runtimeGenerationIds).toEqual([generationId]);
    },
  );

  it("keeps cancellation and invalid ownership state fail closed", () => {
    const cancelledRoot = mkdtempSync(join(tmpdir(), "inertia-bootstrap-safety-"));
    const cancelledData = join(cancelledRoot, "runtime");
    const generationId = "30000000-0000-4000-8000-000000000003:13";
    directories.push(cancelledRoot);
    mkdirSync(cancelledData, { recursive: true, mode: 0o700 });
    expect(new RuntimeGenerationLeaseJournal(cancelledData)
      .publish(generationId, "unavailable")).toBe(true);

    expect(prepareRuntimeBootstrapSafety(cancelledData, "linux")).toEqual({
      systemBootId: "test:00000000-0000-4000-8000-000000000001",
      preserveAttachments: true,
      legacyRecoveryCandidates: [generationId],
    });
    expect(new LegacyRuntimeRecoveryAuthorityJournal(cancelledData)
      .pending("darwin", "test:00000000-0000-4000-8000-000000000001"))
      .toEqual([]);

    writeFileSync(
      join(cancelledData, ".runtime-owned-invalid.json"),
      "invalid",
      { mode: 0o600 },
    );
    expect(prepareRuntimeBootstrapSafety(cancelledData, "darwin")
      .legacyRecoveryCandidates).toEqual([]);
    expect(authorizeLegacyRuntimeRecovery(
      cancelledData,
      [generationId],
      "test:00000000-0000-4000-8000-000000000001",
      "darwin",
    )).toBe(false);
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
      ownedProcesses.begin(
        runtimeGenerationId,
        priorBootId,
        ownedProcesses.sessionCapability(runtimeGenerationId, priorBootId)!,
      );

      expect(prepareRuntimeBootstrapSafety(dataDirectory)).toEqual({
        systemBootId: "test:00000000-0000-4000-8000-000000000001",
        preserveAttachments: false,
        legacyRecoveryCandidates: [],
      });
      leases.refresh();
      expect(leases.all()).toEqual([]);
      expect(ownedProcesses.records(runtimeGenerationId)).toBeNull();
      expect(readdirSync(dataDirectory).some((name) =>
        name.startsWith(".runtime-owned-"))).toBe(false);
    },
  );
});
