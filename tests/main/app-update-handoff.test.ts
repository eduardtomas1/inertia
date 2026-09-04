// @inertia-test-suite portable

import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  appUpdateHandoffCanTransition,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenDigest,
  appUpdateHandoffTokenMatches,
  AppUpdateHandoffJournal,
  createAppUpdateHandoffToken,
  type AppUpdateCandidateBootstrapAcknowledgement,
  type AppUpdateHandoffPhase,
  type AppUpdateHandoffPlatform,
  type AppUpdateHandoffPreparation,
  type AppUpdateHandoffSnapshot,
} from "../../src/main/app-update-handoff";
import { AppUpdateHandoffTokenVault } from
  "../../src/main/app-update-handoff-token-vault";

const directories: string[] = [];
const canonicalName = ".app-update-handoff.json";
const token = "A".repeat(43);
const linuxPath: readonly AppUpdateHandoffPhase[] = [
  "prepared",
  "candidate-launched",
  "candidate-bootstrap-validated",
  "old-generation-cleanup-confirmed",
  "ownership-transfer-committed",
  "candidate-admitted",
  "completed",
];
const windowsPath: readonly AppUpdateHandoffPhase[] = [
  "prepared",
  "old-generation-cleanup-confirmed",
  "ownership-transfer-committed",
  "candidate-launched",
  "candidate-bootstrap-validated",
  "candidate-admitted",
  "completed",
];
const allPhases: readonly AppUpdateHandoffPhase[] = [
  ...new Set([
    ...linuxPath,
    ...windowsPath,
    "rollback-required" as const,
    "rollback-completed" as const,
  ]),
];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-app-update-handoff-"));
  directories.push(path);
  return path;
}

function preparation(
  platform: AppUpdateHandoffPlatform = "linux",
  overrides: Record<string, unknown> = {},
): AppUpdateHandoffPreparation {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    platform,
    channel: "stable",
    oldVersion: "1.2.3",
    newVersion: "1.3.0",
    oldRuntimeGenerationId: "22222222-2222-4222-8222-222222222222:7",
    systemBootId: platform === "linux"
      ? "linux:33333333-3333-4333-8333-333333333333"
      : "win32:deadbeef",
    candidateArtifactDigest: "a".repeat(64),
    candidateExecutableIdentityDigest: "b".repeat(64),
    profileIdentityDigest: "c".repeat(64),
    dataIdentityDigest: "d".repeat(64),
    handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
    createdAt: "2030-01-01T00:00:00.000Z",
    deadlineAt: "2030-01-01T01:00:00.000Z",
    ...overrides,
  } as AppUpdateHandoffPreparation;
}

function timestamp(revision: number): string {
  return `2030-01-01T00:00:${String(revision).padStart(2, "0")}.000Z`;
}

function advance(
  journal: AppUpdateHandoffJournal,
  current: AppUpdateHandoffSnapshot,
  phase: AppUpdateHandoffPhase,
): AppUpdateHandoffSnapshot {
  const next = phase === "candidate-bootstrap-validated"
    ? journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(current),
      candidateAcknowledgement(current),
      timestamp(current.revision),
    )
    : journal.transition(
      appUpdateHandoffOwner(current),
      phase,
      timestamp(current.revision),
    );
  expect(next).not.toBeNull();
  return next!;
}

function candidateAcknowledgement(
  snapshot: AppUpdateHandoffSnapshot,
  overrides: Record<string, unknown> = {},
): AppUpdateCandidateBootstrapAcknowledgement {
  return {
    operationId: snapshot.operationId,
    platform: snapshot.platform,
    channel: snapshot.channel,
    oldVersion: snapshot.oldVersion,
    newVersion: snapshot.newVersion,
    oldRuntimeGenerationId: snapshot.oldRuntimeGenerationId,
    candidateArtifactDigest: snapshot.candidateArtifactDigest,
    candidateExecutableIdentityDigest:
      snapshot.candidateExecutableIdentityDigest,
    profileIdentityDigest: snapshot.profileIdentityDigest,
    dataIdentityDigest: snapshot.dataIdentityDigest,
    handoffToken: token,
    ...overrides,
  } as AppUpdateCandidateBootstrapAcknowledgement;
}

function advanceAlong(
  journal: AppUpdateHandoffJournal,
  path: readonly AppUpdateHandoffPhase[],
  targetIndex: number,
): AppUpdateHandoffSnapshot {
  let current = journal.prepare(preparation(
    path === windowsPath ? "win32" : "linux",
  ))!;
  for (const phase of path.slice(1, targetIndex + 1)) {
    current = advance(journal, current, phase);
  }
  return current;
}

function proposalName(snapshot: AppUpdateHandoffSnapshot, temporary = false): string {
  return `.app-update-handoff-proposal-${snapshot.checksum}.${
    temporary ? "publish.tmp" : "json"
  }`;
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("app update handoff journal", () => {
  it.each([
    ["linux", linuxPath],
    ["win32", windowsPath],
  ] as const)("persists the complete %s handoff lifecycle", (platform, path) => {
    const root = directory();
    const journal = new AppUpdateHandoffJournal(root);
    let current = journal.prepare(preparation(platform));
    expect(current?.phase).toBe("prepared");
    expect(new AppUpdateHandoffJournal(root).current()).toEqual(current);

    for (const phase of path.slice(1)) {
      current = advance(journal, current!, phase);
      expect(new AppUpdateHandoffJournal(root).current()).toEqual(current);
    }

    const diagnostic = journal.diagnostic(new Date("2030-01-01T00:30:00.000Z"));
    expect(diagnostic).toMatchObject({
      state: "terminal",
      phase: "completed",
      platform,
      revision: 7,
      expired: false,
    });
    const serializedDiagnostic = JSON.stringify(diagnostic);
    expect(serializedDiagnostic).not.toContain(token);
    expect(serializedDiagnostic).not.toContain(
      preparation(platform).oldRuntimeGenerationId,
    );
    expect(serializedDiagnostic).not.toContain("a".repeat(64));
    expect(serializedDiagnostic).not.toContain("b".repeat(64));
    expect(serializedDiagnostic).not.toContain("c".repeat(64));
    expect(serializedDiagnostic).not.toContain("d".repeat(64));

    expect(journal.retire(appUpdateHandoffOwner(current!))).toBe(true);
    expect(new AppUpdateHandoffJournal(root).current()).toBeNull();
    expect(readdirSync(root).filter((name) =>
      name.startsWith(".app-update-handoff"))).toEqual([]);
  });

  it("accepts rollback only as a monotonic terminal branch", () => {
    for (const [platform, path] of [
      ["linux", linuxPath],
      ["win32", windowsPath],
    ] as const) {
      for (let index = 0; index < path.length - 1; index += 1) {
        const journal = new AppUpdateHandoffJournal(directory());
        const current = advanceAlong(journal, path, index);
        const rollingBack = journal.transition(
          appUpdateHandoffOwner(current),
          "rollback-required",
          timestamp(current.revision),
        );
        expect(rollingBack?.phase, `${platform} phase ${current.phase}`)
          .toBe("rollback-required");
        const rolledBack = journal.transition(
          appUpdateHandoffOwner(rollingBack!),
          "rollback-completed",
          timestamp(rollingBack!.revision),
        );
        expect(rolledBack?.phase).toBe("rollback-completed");
        expect(journal.transition(
          appUpdateHandoffOwner(rolledBack!),
          "prepared",
          timestamp(rolledBack!.revision),
        )).toBeNull();
      }
    }
  });

  it.each([
    ["linux", linuxPath],
    ["win32", windowsPath],
  ] as const)("rejects skipped, reversed, and cross-platform %s phases", (
    _platform,
    path,
  ) => {
    for (let index = 0; index < path.length; index += 1) {
      const journal = new AppUpdateHandoffJournal(directory());
      const current = advanceAlong(journal, path, index);
      const allowed = path[index + 1];
      for (const candidate of allPhases) {
        if (
          candidate === current.phase
          || candidate === allowed
          || (candidate === "rollback-required" && index < path.length - 1)
        ) continue;
        expect(journal.transition(
          appUpdateHandoffOwner(current),
          candidate,
          timestamp(current.revision),
        ), `${current.phase} -> ${candidate}`).toBeNull();
        expect(journal.current()?.checksum).toBe(current.checksum);
      }
    }
  });

  it("makes exact duplicates idempotent and rejects stale or foreign owners", () => {
    const journal = new AppUpdateHandoffJournal(directory());
    const prepared = journal.prepare(preparation())!;
    expect(journal.transition(
      appUpdateHandoffOwner(prepared),
      "prepared",
      timestamp(1),
    )).toEqual(prepared);

    const launched = advance(journal, prepared, "candidate-launched");
    expect(journal.transition(
      appUpdateHandoffOwner(prepared),
      "candidate-launched",
      timestamp(1),
    )).toEqual(launched);
    expect(journal.transition(
      appUpdateHandoffOwner(prepared),
      "rollback-required",
      timestamp(1),
    )).toBeNull();
    expect(journal.transition({
      ...appUpdateHandoffOwner(launched),
      operationId: "99999999-9999-4999-8999-999999999999",
    }, "candidate-bootstrap-validated", timestamp(2))).toBeNull();
    expect(journal.transition({
      ...appUpdateHandoffOwner(launched),
      checksum: "f".repeat(64),
    }, "candidate-bootstrap-validated", timestamp(2))).toBeNull();
    expect(journal.current()).toEqual(launched);
  });

  it("binds a one-time token by digest without persisting or diagnosing it", () => {
    const root = directory();
    const generated = createAppUpdateHandoffToken();
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(appUpdateHandoffTokenDigest("short")).toBeNull();

    const journal = new AppUpdateHandoffJournal(root);
    const prepared = journal.prepare(preparation())!;
    expect(appUpdateHandoffTokenMatches(prepared, token)).toBe(true);
    expect(appUpdateHandoffTokenMatches(prepared, "B".repeat(43))).toBe(false);
    expect(readFileSync(join(root, canonicalName), "utf8")).not.toContain(token);
    expect(JSON.stringify(journal.diagnostic())).not.toContain(token);
    expect(journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(prepared),
      candidateAcknowledgement(prepared),
      timestamp(1),
    )).toBeNull();

    const launched = advance(journal, prepared, "candidate-launched");
    expect(journal.transition(
      appUpdateHandoffOwner(launched),
      "candidate-bootstrap-validated",
      timestamp(2),
    )).toBeNull();
    expect(journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(launched),
      candidateAcknowledgement(launched, { handoffToken: "B".repeat(43) }),
      timestamp(2),
    )).toBeNull();
    expect(journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(launched),
      candidateAcknowledgement(launched, {
        candidateExecutableIdentityDigest: "e".repeat(64),
      }),
      timestamp(2),
    )).toBeNull();
    expect(journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(launched),
      candidateAcknowledgement(launched, { extra: "rejected" }),
      timestamp(2),
    )).toBeNull();
    const validated = journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(launched),
      candidateAcknowledgement(launched),
      timestamp(2),
    );
    expect(validated?.phase).toBe("candidate-bootstrap-validated");
    expect(journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(launched),
      candidateAcknowledgement(launched),
      timestamp(2),
    )).toEqual(validated);
    const cleaned = advance(
      journal,
      validated!,
      "old-generation-cleanup-confirmed",
    );
    expect(journal.acknowledgeCandidateBootstrap(
      appUpdateHandoffOwner(launched),
      candidateAcknowledgement(launched),
      timestamp(2),
    )).toBeNull();
    expect(journal.current()).toEqual(cleaned);
  });

  it("publishes, exclusively claims, recovers, and consumes the Windows token receipt", () => {
    const root = directory();
    const journal = new AppUpdateHandoffJournal(root);
    const prepared = journal.prepare(preparation("win32"))!;
    const vault = new AppUpdateHandoffTokenVault(root, {
      clock: () => new Date("2030-01-01T00:30:00.000Z"),
    });

    expect(vault.publish(prepared, token)).toBe(true);
    expect(vault.publish(prepared, token)).toBe(true);
    expect(vault.matches(prepared)).toBe(true);
    expect(vault.publish(prepared, "B".repeat(43))).toBe(false);

    const claim = vault.claim(prepared);
    expect(claim?.token).toBe(token);
    expect(vault.claim(prepared)).toBeNull();
    expect(readdirSync(root)).toContain(".app-update-secret.claimed");

    // A later singleton owner may recover a claim left by a crashed process.
    const recovered = new AppUpdateHandoffTokenVault(root, {
      clock: () => new Date("2030-01-01T00:30:01.000Z"),
    }).claim(prepared, { recoverAbandonedClaim: true });
    expect(recovered?.token).toBe(token);
    expect(recovered?.rollback()).toBe(true);
    expect(readdirSync(root)).toContain(".app-update-secret.json");

    const finalClaim = vault.claim(prepared);
    expect(finalClaim?.commit()).toBe(true);
    expect(finalClaim?.commit()).toBe(true);
    expect(vault.matches(prepared)).toBe(false);
    expect(readdirSync(root).filter((name) =>
      name.startsWith(".app-update-secret"))).toEqual([]);
  });

  it("fails the Windows token receipt closed on expiry, corruption, or foreign keys", () => {
    const expiredRoot = directory();
    const expired = new AppUpdateHandoffJournal(expiredRoot).prepare(
      preparation("win32"),
    )!;
    const expiredVault = new AppUpdateHandoffTokenVault(expiredRoot, {
      clock: () => new Date("2030-01-01T01:00:00.001Z"),
    });
    expect(expiredVault.publish(expired, token)).toBe(true);
    expect(expiredVault.claim(expired)).toBeNull();

    for (const mutate of [
      (value: Record<string, unknown>) => { value.handoffToken = "B".repeat(43); },
      (value: Record<string, unknown>) => { value.unexpected = true; },
      (value: Record<string, unknown>) => { value.schemaVersion = 2; },
    ]) {
      const root = directory();
      const prepared = new AppUpdateHandoffJournal(root).prepare(
        preparation("win32"),
      )!;
      const vault = new AppUpdateHandoffTokenVault(root);
      expect(vault.publish(prepared, token)).toBe(true);
      const receiptPath = join(root, ".app-update-secret.json");
      const value = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<
        string,
        unknown
      >;
      mutate(value);
      writeFileSync(receiptPath, JSON.stringify(value), { mode: 0o600 });
      expect(() => new AppUpdateHandoffTokenVault(root).matches(prepared))
        .toThrow("token receipt is invalid");
    }
  });

  it("recovers an integrity-checked token publisher crash prefix", () => {
    const root = directory();
    const prepared = new AppUpdateHandoffJournal(root).prepare(
      preparation("win32"),
    )!;
    let interrupt = true;
    const interrupted = new AppUpdateHandoffTokenVault(root, {
      testHooks: {
        afterTemporaryFileClosed: () => {
          if (!interrupt) return;
          interrupt = false;
          throw new Error("simulated token publisher crash");
        },
      },
    });
    expect(interrupted.publish(prepared, token)).toBe(false);
    expect(new AppUpdateHandoffTokenVault(root).matches(prepared)).toBe(true);
    expect(readdirSync(root).filter((name) =>
      name.startsWith(".app-update-secret"))).toEqual([
      ".app-update-secret.json",
    ]);
  });

  it("enforces bounded identities, versions, digests, boots, and deadlines", () => {
    const invalid: readonly Record<string, unknown>[] = [
      { operationId: "11111111-1111-4111-8111-11111111111A" },
      { platform: "darwin" },
      { channel: "nightly" },
      { oldVersion: "01.2.3" },
      { newVersion: "1.2.3" },
      { newVersion: "1.2.2" },
      { oldRuntimeGenerationId: "pid:42" },
      { systemBootId: "unavailable" },
      { systemBootId: "win32:deadbeef" },
      { candidateArtifactDigest: "A".repeat(64) },
      { candidateExecutableIdentityDigest: "b".repeat(63) },
      { profileIdentityDigest: null },
      { handoffTokenDigest: "secret" },
      { createdAt: "2030-01-01T00:00:00Z" },
      { deadlineAt: "2030-01-01T00:00:00.000Z" },
      { deadlineAt: "2030-01-03T00:00:00.000Z" },
      { unexpectedSensitiveField: "must not be serialized" },
    ];
    for (const override of invalid) {
      const root = directory();
      expect(new AppUpdateHandoffJournal(root).prepare(
        preparation("linux", override),
      ), JSON.stringify(override)).toBeNull();
      expect(readdirSync(root)).toEqual([]);
    }
  });

  it("allows only rollback after the bounded success deadline", () => {
    const journal = new AppUpdateHandoffJournal(directory());
    const prepared = journal.prepare(preparation())!;
    expect(journal.transition(
      appUpdateHandoffOwner(prepared),
      "candidate-launched",
      "2030-01-01T01:00:00.001Z",
    )).toBeNull();
    const rollback = journal.transition(
      appUpdateHandoffOwner(prepared),
      "rollback-required",
      "2030-01-02T00:00:00.000Z",
    );
    expect(rollback?.phase).toBe("rollback-required");
    expect(journal.transition(
      appUpdateHandoffOwner(rollback!),
      "rollback-completed",
      "2030-01-02T00:00:01.000Z",
    )?.phase).toBe("rollback-completed");
    expect(journal.diagnostic(new Date("2030-01-02T00:00:02.000Z")))
      .toMatchObject({ state: "terminal", expired: true });
  });

  it("repairs exact publisher crash prefixes and discards partial publishers", () => {
    const root = directory();
    let interrupt = true;
    let temporaryPath = "";
    const interrupted = new AppUpdateHandoffJournal(root, {
      testHooks: {
        afterTemporaryFileClosed: (path) => {
          if (!interrupt) return;
          interrupt = false;
          temporaryPath = path;
          throw new Error("simulated crash after fsync");
        },
      },
    });
    expect(interrupted.prepare(preparation())).toBeNull();
    expect(temporaryPath).toContain(".publish.tmp");
    expect(new AppUpdateHandoffJournal(root).current()?.phase).toBe("prepared");
    expect(readdirSync(root).filter((name) =>
      name.startsWith(".app-update-handoff"))).toEqual([canonicalName]);

    const partialRoot = directory();
    interrupt = true;
    temporaryPath = "";
    const partial = new AppUpdateHandoffJournal(partialRoot, {
      testHooks: {
        afterTemporaryFileClosed: (path) => {
          temporaryPath = path;
          throw new Error("simulated crash after fsync");
        },
      },
    });
    expect(partial.prepare(preparation())).toBeNull();
    writeFileSync(temporaryPath, "{");
    chmodSync(temporaryPath, 0o600);
    expect(new AppUpdateHandoffJournal(partialRoot).current()).toBeNull();
    expect(readdirSync(partialRoot)).toEqual([]);
  });

  it("recovers a committed transition after interruption at the rename boundary", () => {
    const root = directory();
    let interruptCommit = false;
    const journal = new AppUpdateHandoffJournal(root, {
      testHooks: {
        afterRename: (_source, target) => {
          if (interruptCommit && target.endsWith(canonicalName)) {
            interruptCommit = false;
            throw new Error("simulated crash after transition rename");
          }
        },
      },
    });
    const prepared = journal.prepare(preparation())!;
    interruptCommit = true;
    expect(() => journal.transition(
      appUpdateHandoffOwner(prepared),
      "candidate-launched",
      timestamp(1),
    )).toThrow("could not be committed");
    expect(new AppUpdateHandoffJournal(root).current()?.phase)
      .toBe("candidate-launched");
  });

  it("projects diagnostics without recovering or rewriting interrupted proposals", () => {
    const root = directory();
    let interruptCommit = false;
    const journal = new AppUpdateHandoffJournal(root, {
      testHooks: {
        beforeRename: (source, target) => {
          if (
            interruptCommit
            && source.includes(".app-update-handoff-proposal-")
            && source.endsWith(".json")
            && target.endsWith(canonicalName)
          ) {
            interruptCommit = false;
            throw new Error("simulated transition interruption");
          }
        },
      },
    });
    const prepared = journal.prepare(preparation())!;
    interruptCommit = true;
    expect(() => journal.transition(
      appUpdateHandoffOwner(prepared),
      "candidate-launched",
      timestamp(1),
    )).toThrow("could not be committed");
    const before = Object.fromEntries(readdirSync(root)
      .filter((name) => name.startsWith(".app-update-handoff"))
      .map((name) => [name, readFileSync(join(root, name)).toString("base64")]));

    expect(new AppUpdateHandoffJournal(root).diagnostic()).toMatchObject({
      state: "active",
      phase: "prepared",
      revision: 1,
    });

    const after = Object.fromEntries(readdirSync(root)
      .filter((name) => name.startsWith(".app-update-handoff"))
      .map((name) => [name, readFileSync(join(root, name)).toString("base64")]));
    expect(after).toEqual(before);
  });

  it("replays terminal consume cleanup without accepting a nonterminal consume", () => {
    const root = directory();
    let interruptRetirement = true;
    const journal = new AppUpdateHandoffJournal(root, {
      testHooks: {
        beforeUnlink: (path) => {
          if (interruptRetirement && path.endsWith(".consume.tmp")) {
            interruptRetirement = false;
            throw new Error("simulated crash before consume retirement");
          }
        },
      },
    });
    let current = advanceAlong(journal, linuxPath, linuxPath.length - 1);
    expect(journal.retire(appUpdateHandoffOwner(current))).toBe(false);
    expect(readdirSync(root)).toContain(".app-update-handoff.consume.tmp");
    expect(journal.retire(appUpdateHandoffOwner(current))).toBe(true);
    expect(journal.current()).toBeNull();

    const invalidRoot = directory();
    current = new AppUpdateHandoffJournal(invalidRoot).prepare(preparation())!;
    copyFileSync(
      join(invalidRoot, canonicalName),
      join(invalidRoot, ".app-update-handoff.consume.tmp"),
    );
    rmSync(join(invalidRoot, canonicalName));
    expect(() => new AppUpdateHandoffJournal(invalidRoot).current())
      .toThrow("consume authority is invalid");
  });

  it.each([
    ["checksum mismatch", (value: Record<string, unknown>) => {
      value.phase = "candidate-launched";
    }],
    ["extra key", (value: Record<string, unknown>) => {
      value.extra = true;
    }],
    ["unsupported schema", (value: Record<string, unknown>) => {
      value.schemaVersion = 2;
    }],
    ["noncanonical checksum", (value: Record<string, unknown>) => {
      value.checksum = String(value.checksum).toUpperCase();
    }],
    ["out-of-range revision", (value: Record<string, unknown>) => {
      value.revision = 99;
    }],
  ])("preserves canonical evidence with %s", (_name, mutate) => {
    const root = directory();
    expect(new AppUpdateHandoffJournal(root).prepare(preparation())).not.toBeNull();
    const path = join(root, canonicalName);
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    mutate(value);
    const damaged = JSON.stringify(value);
    writeFileSync(path, damaged);
    chmodSync(path, 0o600);
    expect(() => new AppUpdateHandoffJournal(root).current())
      .toThrow("journal is invalid");
    expect(readFileSync(path, "utf8")).toBe(damaged);
  });

  it("rejects foreign, symlinked, ambiguous, and out-of-order authorities", () => {
    const foreignRoot = directory();
    const foreign = join(foreignRoot, ".app-update-handoff.foreign");
    writeFileSync(foreign, "keep", { mode: 0o600 });
    expect(() => new AppUpdateHandoffJournal(foreignRoot).current())
      .toThrow("foreign entry");
    expect(readFileSync(foreign, "utf8")).toBe("keep");

    const outside = directory();
    const sentinel = join(outside, "sentinel");
    writeFileSync(sentinel, "outside", { mode: 0o600 });
    const linkedRoot = directory();
    symlinkSync(
      process.platform === "win32" ? outside : sentinel,
      join(linkedRoot, canonicalName),
      process.platform === "win32" ? "junction" : "file",
    );
    expect(() => new AppUpdateHandoffJournal(linkedRoot).current())
      .toThrow("unsafe");
    expect(readFileSync(sentinel, "utf8")).toBe("outside");

    const firstSource = directory();
    const first = new AppUpdateHandoffJournal(firstSource)
      .prepare(preparation())!;
    const secondSource = directory();
    const second = new AppUpdateHandoffJournal(secondSource).prepare(preparation(
      "linux",
      { operationId: "44444444-4444-4444-8444-444444444444" },
    ))!;
    const ambiguousRoot = directory();
    copyFileSync(
      join(firstSource, canonicalName),
      join(ambiguousRoot, proposalName(first)),
    );
    copyFileSync(
      join(secondSource, canonicalName),
      join(ambiguousRoot, proposalName(second)),
    );
    expect(() => new AppUpdateHandoffJournal(ambiguousRoot).current())
      .toThrow("preparation is ambiguous");

    const laterSource = directory();
    const laterJournal = new AppUpdateHandoffJournal(laterSource);
    const launched = advance(
      laterJournal,
      laterJournal.prepare(preparation())!,
      "candidate-launched",
    );
    const bootstrap = advance(
      laterJournal,
      launched,
      "candidate-bootstrap-validated",
    );
    const outOfOrderRoot = directory();
    new AppUpdateHandoffJournal(outOfOrderRoot).prepare(preparation());
    copyFileSync(
      join(laterSource, canonicalName),
      join(outOfOrderRoot, proposalName(bootstrap)),
    );
    expect(() => new AppUpdateHandoffJournal(outOfOrderRoot).current())
      .toThrow("out of order");
  });

  it("retires stale same-owner proposals but blocks a changed immutable identity", () => {
    const sourceRoot = directory();
    const sourceJournal = new AppUpdateHandoffJournal(sourceRoot);
    const prepared = sourceJournal.prepare(preparation())!;
    const preparedBytes = readFileSync(join(sourceRoot, canonicalName));
    const launched = advance(sourceJournal, prepared, "candidate-launched");

    copyFileSync(
      join(sourceRoot, canonicalName),
      join(sourceRoot, proposalName(launched)),
    );
    writeFileSync(join(sourceRoot, proposalName(prepared)), preparedBytes, {
      mode: 0o600,
    });
    expect(sourceJournal.current()).toEqual(launched);
    expect(readdirSync(sourceRoot).filter((name) =>
      name.includes("proposal"))).toEqual([]);

    const foreignSource = directory();
    const foreign = new AppUpdateHandoffJournal(foreignSource).prepare(preparation(
      "linux",
      { operationId: "55555555-5555-4555-8555-555555555555" },
    ))!;
    copyFileSync(
      join(foreignSource, canonicalName),
      join(sourceRoot, proposalName(foreign)),
    );
    expect(() => sourceJournal.current()).toThrow("stale identity");
  });

  it("exposes the platform graph independently of journal mutation", () => {
    expect(appUpdateHandoffCanTransition(
      "linux",
      "prepared",
      "candidate-launched",
    )).toBe(true);
    expect(appUpdateHandoffCanTransition(
      "win32",
      "prepared",
      "old-generation-cleanup-confirmed",
    )).toBe(true);
    expect(appUpdateHandoffCanTransition(
      "win32",
      "prepared",
      "candidate-launched",
    )).toBe(false);
    expect(appUpdateHandoffCanTransition(
      "linux",
      "completed",
      "rollback-required",
    )).toBe(false);
  });
});
