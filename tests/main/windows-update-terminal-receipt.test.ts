// @inertia-test-suite portable

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenDigest,
} from "../../src/main/app-update-handoff";
import {
  createWindowsUpdateTerminalReceipt,
  parseWindowsUpdateOperationClaim,
  parseWindowsUpdateTerminalReceipt,
  retireWindowsUpdateSupervisorArtifacts,
  serializeWindowsUpdateTerminalReceipt,
  WindowsUpdateTerminalReceiptJournal,
  windowsUpdateSupervisorArtifactPresent,
  windowsUpdateSupervisorExecutableName,
  windowsUpdateOperationClaimAuthenticationTag,
  windowsUpdateTerminalAuthenticationTag,
  windowsUpdateTerminalReceiptMatches,
  windowsUpdateTerminalReceiptMatchesQuarantine,
  windowsUpdateTerminalReceiptMatchesTransferredAuthority,
  windowsUpdateTerminalReceiptName,
  windowsUpdateTerminalReceiptTemporaryName,
} from "../../src/main/windows-update-terminal-receipt";

const roots: string[] = [];
const operationId = "11111111-1111-4111-8111-111111111111";
const token = "A".repeat(43);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-win-terminal-"));
  roots.push(root);
  const dataDirectory = join(root, "data");
  await mkdir(dataDirectory, { mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const now = Date.now();
  const journal = new AppUpdateHandoffJournal(dataDirectory);
  const prepared = journal.prepare({
    operationId,
    platform: "win32",
    channel: "stable",
    oldVersion: "1.2.3",
    newVersion: "1.3.0",
    oldRuntimeGenerationId:
      "22222222-2222-4222-8222-222222222222:7",
    systemBootId: "win32:deadbeef",
    candidateArtifactDigest: "a".repeat(64),
    candidateExecutableIdentityDigest: "b".repeat(64),
    profileIdentityDigest: "c".repeat(64),
    dataIdentityDigest: "d".repeat(64),
    handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
  })!;
  const cleaned = journal.transition(
    appUpdateHandoffOwner(prepared),
    "old-generation-cleanup-confirmed",
  )!;
  const executableDigest = "e".repeat(64);
  const supervisorBytes = Buffer.from("exact supervisor");
  const receipt = createWindowsUpdateTerminalReceipt({
    schemaVersion: 1,
    operationId,
    handoffChecksum: cleaned.checksum,
    outcome: "success",
    installerExitCode: 0,
    installerDigest: cleaned.candidateArtifactDigest,
    supervisorDigest: createHash("sha256")
      .update(supervisorBytes)
      .digest("hex"),
    executableDigest,
    parentCreationTimeBits: "123456789",
    completedAt: cleaned.transitionedAt,
  }, token);
  return {
    cleaned,
    dataDirectory,
    executableDigest,
    journal,
    receipt,
    supervisorBytes,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { force: true, recursive: true })));
});

describe("Windows update terminal receipts", () => {
  it("strictly authenticates one pre-terminal operation owner", () => {
    const payload = {
      schemaVersion: 1 as const,
      operationId,
      handoffChecksum: "a".repeat(64),
      launchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      supervisorDigest: "c".repeat(64),
      deadlineAt: "2026-09-04T12:34:56.789Z",
    };
    const authenticationTag = windowsUpdateOperationClaimAuthenticationTag(
      payload,
      token,
    );
    expect(authenticationTag).toBe(
      "622bd239c6e10c6d3cef1fdf66d78bf80daec46f1252841771e4adc1f22843f5",
    );
    expect(parseWindowsUpdateOperationClaim(Buffer.from(JSON.stringify({
      ...payload,
      authenticationTag,
    }), "utf8"))).toMatchObject(payload);
    expect(parseWindowsUpdateOperationClaim(Buffer.from(JSON.stringify({
      ...payload,
      authenticationTag,
      launchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }), "utf8"))).not.toBeNull();
    expect(windowsUpdateOperationClaimAuthenticationTag({
      ...payload,
      launchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }, token)).not.toBe(authenticationTag);
    expect(parseWindowsUpdateOperationClaim(Buffer.from(JSON.stringify({
      ...payload,
      authenticationTag,
      extra: true,
    }), "utf8"))).toBeNull();
  });

  it("matches the native supervisor's canonical HMAC test vector", () => {
    expect(windowsUpdateTerminalAuthenticationTag({
      schemaVersion: 1,
      operationId,
      handoffChecksum: "a".repeat(64),
      outcome: "success",
      installerExitCode: 0,
      installerDigest: "b".repeat(64),
      supervisorDigest: "c".repeat(64),
      executableDigest: "d".repeat(64),
      parentCreationTimeBits: "123456789",
      completedAt: "2026-09-04T12:34:56.789Z",
    }, token)).toBe(
      "a5973234b3c8024edfc0e49d308fc060b4c8bf5bf896b9c029203e4261a6aab6",
    );
  });

  it("authenticates the exact terminal outcome and rejects mutation or lateness", async () => {
    const value = await fixture();
    const bytes = serializeWindowsUpdateTerminalReceipt(value.receipt);

    expect(parseWindowsUpdateTerminalReceipt(bytes)).toEqual(value.receipt);
    expect(windowsUpdateTerminalReceiptMatches({
      receipt: value.receipt,
      snapshot: value.cleaned,
      handoffToken: token,
      outcome: "success",
      executableDigest: value.executableDigest,
    })).toBe(true);
    expect(windowsUpdateTerminalReceiptMatches({
      receipt: value.receipt,
      snapshot: value.cleaned,
      handoffToken: "B".repeat(43),
      outcome: "success",
      executableDigest: value.executableDigest,
    })).toBe(false);
    expect(windowsUpdateTerminalReceiptMatches({
      receipt: { ...value.receipt, outcome: "clean-failure" },
      snapshot: value.cleaned,
      handoffToken: token,
      outcome: "clean-failure",
      executableDigest: value.executableDigest,
    })).toBe(false);
    expect(() => createWindowsUpdateTerminalReceipt({
      ...value.receipt,
      outcome: "clean-failure",
      installerExitCode: 1,
    }, token)).toThrow("terminal receipt is invalid");
    const late = createWindowsUpdateTerminalReceipt({
      ...value.receipt,
      completedAt: new Date(
        Date.parse(value.cleaned.deadlineAt) + 1,
      ).toISOString(),
    }, token);
    expect(windowsUpdateTerminalReceiptMatches({
      receipt: late,
      snapshot: value.cleaned,
      handoffToken: token,
      outcome: "success",
      executableDigest: value.executableDigest,
    })).toBe(false);
  });

  it("authenticates a durable quarantine without granting success or rollback", async () => {
    const value = await fixture();
    const quarantined = createWindowsUpdateTerminalReceipt({
      ...value.receipt,
      outcome: "quarantined",
      installerExitCode: null,
      executableDigest: null,
      completedAt: new Date(
        Date.parse(value.cleaned.deadlineAt) + 1,
      ).toISOString(),
    }, token);

    expect(windowsUpdateTerminalReceiptMatchesQuarantine({
      receipt: quarantined,
      snapshot: value.cleaned,
      handoffToken: token,
    })).toBe(true);
    expect(windowsUpdateTerminalReceiptMatchesQuarantine({
      receipt: quarantined,
      snapshot: value.cleaned,
      handoffToken: "B".repeat(43),
    })).toBe(false);
    expect(windowsUpdateTerminalReceiptMatches({
      receipt: quarantined,
      snapshot: value.cleaned,
      handoffToken: token,
      outcome: "success",
      executableDigest: value.executableDigest,
    })).toBe(false);
  });

  it("binds crash replay to the exact cleanup predecessor", async () => {
    const value = await fixture();
    const transferred = value.journal.transition(
      appUpdateHandoffOwner(value.cleaned),
      "ownership-transfer-committed",
    )!;
    expect(windowsUpdateTerminalReceiptMatchesTransferredAuthority({
      receipt: value.receipt,
      snapshot: transferred,
      handoffToken: token,
      outcome: "success",
      executableDigest: value.executableDigest,
    })).toBe(true);
    const unrelated = { ...value.receipt, handoffChecksum: "f".repeat(64) };
    expect(windowsUpdateTerminalReceiptMatchesTransferredAuthority({
      receipt: unrelated,
      snapshot: transferred,
      handoffToken: token,
      outcome: "success",
      executableDigest: value.executableDigest,
    })).toBe(false);
  });

  it("fails closed for incomplete or duplicate receipt publication", async () => {
    const value = await fixture();
    await writeFile(
      join(
        value.dataDirectory,
        windowsUpdateTerminalReceiptTemporaryName(operationId),
      ),
      serializeWindowsUpdateTerminalReceipt(value.receipt),
      { mode: 0o600 },
    );
    expect(() => new WindowsUpdateTerminalReceiptJournal(
      value.dataDirectory,
    ).current(operationId)).toThrow("storage is ambiguous");
    await rm(join(
      value.dataDirectory,
      windowsUpdateTerminalReceiptTemporaryName(operationId),
    ));
    await writeFile(
      join(value.dataDirectory, ".app-update-terminal-receipt-foreign.json"),
      "{}",
      { mode: 0o600 },
    );
    expect(() => new WindowsUpdateTerminalReceiptJournal(
      value.dataDirectory,
    ).current(operationId)).toThrow("storage is ambiguous");
  });

  it("retires the exact helper before its authenticated receipt", async () => {
    const value = await fixture();
    const helperPath = join(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    );
    const receiptPath = join(
      value.dataDirectory,
      windowsUpdateTerminalReceiptName(operationId),
    );
    await Promise.all([
      writeFile(helperPath, value.supervisorBytes, { mode: 0o700 }),
      writeFile(
        receiptPath,
        serializeWindowsUpdateTerminalReceipt(value.receipt),
        { mode: 0o600 },
      ),
    ]);

    await expect(retireWindowsUpdateSupervisorArtifacts({
      dataDirectory: value.dataDirectory,
      receipt: value.receipt,
      retries: 1,
    })).resolves.toBe(true);
    expect(windowsUpdateSupervisorArtifactPresent({
      dataDirectory: value.dataDirectory,
      operationId,
    })).toBe(false);
    expect(new WindowsUpdateTerminalReceiptJournal(
      value.dataDirectory,
    ).current(operationId)).toBeNull();
    await expect(readFile(helperPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never removes a helper whose exact digest is not authenticated", async () => {
    const value = await fixture();
    const helperPath = join(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    );
    await writeFile(helperPath, "substituted supervisor", { mode: 0o700 });

    await expect(retireWindowsUpdateSupervisorArtifacts({
      dataDirectory: value.dataDirectory,
      receipt: value.receipt,
      retries: 1,
    })).resolves.toBe(false);
    await expect(readFile(helperPath, "utf8")).resolves.toBe(
      "substituted supervisor",
    );
  });
});
