import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeDiagnostics,
  runtimeDiagnosticsDirectory,
  sanitizeRuntimeDiagnosticText,
} from "../../src/main/runtime-diagnostics";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-runtime-diagnostics-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime diagnostics", () => {
  it("logs only allowlisted lifecycle fields and redacts unsafe failure values", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory);
    diagnostics.record("runtime.failure", {
      phase: "restarting",
      generation: 2,
      message: "prompt='rewrite secret' source=/home/alice/private.ts token=ghp_1234567890 password=hunter2 user=dev@example.com",
      prompt: "must never be serialized",
      source: "export const secret = true",
      tokens: 1234,
      credential: "hunter2",
      websocketUrl: "ws://127.0.0.1/runtime/sensitive-capability",
    });

    const content = readFileSync(join(directory, "runtime.log"), "utf8");
    expect(content).toContain('"event":"runtime.failure"');
    expect(content).toContain('"phase":"restarting"');
    expect(content).not.toContain("rewrite secret");
    expect(content).not.toContain("private.ts");
    expect(content).not.toContain("ghp_1234567890");
    expect(content).not.toContain("hunter2");
    expect(content).not.toContain("dev@example.com");
    expect(content).not.toContain("must never be serialized");
    expect(content).not.toContain("export const secret");
    expect(content).not.toContain("1234");
    expect(content).not.toContain("sensitive-capability");
    expect(content).not.toMatch(/prompt|source|tokens?|credential/iu);
  });

  it("redacts credentials, content-shaped fields, paths, and control characters", () => {
    const sanitized = sanitizeRuntimeDiagnosticText(
      "Bearer abc.def prompt:hello source='private code' tokens=987 credential=my-secret at C:\\Users\\Alice\\project, /tmp/inertia/source.ts, and /mnt/customer/private.txt\u0000",
    );
    expect(sanitized).not.toContain("abc.def");
    expect(sanitized).not.toContain("hello");
    expect(sanitized).not.toContain("private code");
    expect(sanitized).not.toContain("987");
    expect(sanitized).not.toContain("my-secret");
    expect(sanitized).not.toContain("Alice");
    expect(sanitized).not.toContain("source.ts");
    expect(sanitized).not.toContain("customer");
    expect(sanitized).not.toContain("private.txt");
    expect(sanitized).not.toContain("\u0000");
  });

  it("retains allowlisted lifecycle failure detail without admitting raw errors", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory);
    diagnostics.record("runtime.failure", {
      phase: "stopping",
      message: "Runtime shutdown could not confirm owned-process cleanup.",
    });
    diagnostics.record("runtime.failure", {
      phase: "stopped",
      message: "arbitrary provider failure detail",
    });
    diagnostics.record("runtime.failure", {
      phase: "stopping",
      message: "The runtime process tree could not be confirmed stopped. prompt=private source=/mnt/customer/private.txt",
    });

    const content = readFileSync(join(directory, "runtime.log"), "utf8");
    expect(content).toContain(
      "Runtime shutdown could not confirm owned-process cleanup.",
    );
    expect(content).not.toContain("arbitrary provider failure detail");
    expect(content).not.toContain("customer");
    expect(content).not.toContain("private.txt");
    expect(content).toContain(
      "The runtime process tree could not be confirmed stopped.",
    );
    expect(content).toContain("Runtime lifecycle failure detail omitted.");
  });

  it("exposes only classified detached-draft recovery diagnostics", () => {
    const root = fixture();
    const diagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(root));
    diagnostics.record("detached-draft.recovery", {
      reason: "invalid-json",
      outcome: "recovered",
      evidencePreserved: true,
      draft: "private draft text",
      path: "/Users/alice/private/detached-chat-pending-drafts.json",
      error: "raw filesystem detail",
      message: "message containing another private detached draft",
      phase: "ready",
      generation: 42,
      restartScheduled: true,
    });

    const report = diagnostics.supportReport({
      version: "0.0.41",
      platform: "darwin",
      architecture: "arm64",
      runtime: null,
    });

    expect(report.text).toContain("detached-draft.recovery");
    expect(report.text).toContain("reason=invalid-json");
    expect(report.text).toContain("outcome=recovered");
    expect(report.text).toContain("evidence=preserved");
    expect(report.text).not.toContain("private draft text");
    expect(report.text).not.toContain("alice");
    expect(report.text).not.toContain("pending-drafts");
    expect(report.text).not.toContain("raw filesystem detail");
    expect(report.text).not.toContain("another private detached draft");
    expect(report.text).not.toContain("phase=ready");
    expect(report.text).not.toContain("generation=42");
    expect(report.text).not.toContain("scheduled=yes");
  });

  it("rotates within fixed file and byte bounds and removes expired generations", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const now = Date.now();
    const diagnostics = new RuntimeDiagnostics(directory, {
      maxFileBytes: 480,
      maxFiles: 3,
      retentionMs: 60_000,
      now: () => now,
    });
    diagnostics.ensureDirectory();
    const expired = join(directory, "runtime.2.log");
    writeFileSync(expired, "{\"event\":\"expired\"}\n", { mode: 0o600 });
    const old = new Date(now - 120_000);
    utimesSync(expired, old, old);

    for (let index = 0; index < 40; index += 1) {
      diagnostics.record("runtime.failure", { phase: "restarting", generation: index, message: "bounded failure detail" });
    }

    const files = readdirSync(directory).filter((name) => name.endsWith(".log")).sort();
    expect(files).toEqual(["runtime.1.log", "runtime.2.log", "runtime.log"]);
    expect(files.every((name) => statSync(join(directory, name)).size <= 480)).toBe(true);
    if (process.platform !== "win32") {
      expect(files.every((name) => (statSync(join(directory, name)).mode & 0o777) === 0o600)).toBe(true);
    }
    expect(files.map((name) => readFileSync(join(directory, name), "utf8")).join("")).not.toContain("expired");
  });

  it("uses a dedicated directory with private directory and file permissions", () => {
    if (process.platform === "win32") return;
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory);
    diagnostics.record("app.start");

    expect(directory).toBe(join(root, "logs", "runtime"));
    expect(statSync(directory).isDirectory()).toBe(true);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "runtime.log")).mode & 0o777).toBe(0o600);

    chmodSync(directory, 0o755);
    diagnostics.ensureDirectory();
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it("uses one locale-independent canonical digest across platforms", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory, {
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    });

    diagnostics.record("app.start");

    expect(JSON.parse(
      readFileSync(join(directory, "runtime.log"), "utf8"),
    )).toEqual({
      schemaVersion: 1,
      at: "2030-01-01T00:00:00.000Z",
      event: "app.start",
      recordDigest:
        "6d8cf0b874fc99e4b4134bd60092572f3459f58f7afd7d2bd5de92843b327c65",
    });
  });

  it("finishes bounded short writes before publishing a diagnostic record", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const writes: number[] = [];
    const diagnostics = new RuntimeDiagnostics(directory, {
      write: (descriptor, buffer, offset, length) => {
        const boundedLength = Math.min(7, length);
        writes.push(boundedLength);
        return writeSync(
          descriptor,
          buffer,
          offset,
          boundedLength,
        );
      },
    });

    diagnostics.record("app.start");

    const content = readFileSync(join(directory, "runtime.log"), "utf8");
    expect(writes.length).toBeGreaterThan(1);
    expect(content.endsWith("\n")).toBe(true);
    expect(diagnostics.supportReport({
      version: "0.0.10",
      platform: "linux",
      architecture: "x64",
      runtime: null,
    })).toMatchObject({ eventCount: 1 });
  });

  it("rejects a crash-truncated tail and resumes at the next record boundary", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory);
    diagnostics.ensureDirectory();
    writeFileSync(
      join(directory, "runtime.log"),
      '{"schemaVersion":1,"at":"2030-01-01T00:00:00.000Z"',
      { mode: 0o600 },
    );

    diagnostics.record("app.start");
    diagnostics.record("app.stop");

    const report = diagnostics.supportReport({
      version: "0.0.10",
      platform: "linux",
      architecture: "x64",
      runtime: null,
    });
    expect(report.eventCount).toBe(1);
    expect(report.text).not.toContain("app.start");
    expect(report.text).toContain("app.stop");
  });

  it("builds a bounded support summary from allowlisted lifecycle fields only", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory, {
      now: Date.now,
    });
    diagnostics.record("runtime.failure", {
      phase: "restarting",
      generation: 7,
      restartAttempt: 2,
      restartScheduled: true,
      message:
        "prompt=private source=/Users/alice/project.ts token=secret credential=hunter2 exited unexpectedly (code 9)",
      providerOutput: "must never appear",
      websocketUrl: "ws://127.0.0.1/private-capability",
    });

    const report = diagnostics.supportReport({
      version: "0.0.10",
      platform: "darwin",
      architecture: "arm64",
      runtime: {
        phase: "restarting",
        generation: 7,
        pid: 1234,
        websocketUrl: "ws://127.0.0.1/private-capability",
        runtimeGenerationHash: null,
        lastError: "private runtime error",
        startupBlockerCode: null,
        restartAttempt: 2,
        restartScheduled: true,
      },
    });

    expect(report.eventCount).toBe(1);
    expect(report.text).toContain("Version: 0.0.10");
    expect(report.text).toContain("Channel: stable");
    expect(report.text).toContain("Platform: darwin");
    expect(report.text).toContain("Runtime: restarting");
    expect(report.text).toContain("Runtime generation: 7");
    expect(report.text).toContain("Runtime process exited unexpectedly (code 9).");
    expect(report.text).not.toContain("private");
    expect(report.text).not.toContain("alice");
    expect(report.text).not.toContain("project.ts");
    expect(report.text).not.toContain("hunter2");
    expect(report.text).not.toContain("providerOutput");
    expect(report.text).not.toContain("127.0.0.1");
    expect(report.text).not.toContain("1234");
    expect(Buffer.byteLength(report.text)).toBeLessThanOrEqual(64 * 1_024);
  });

  it("rejects legacy, tampered, and non-strict diagnostic records", () => {
    const root = fixture();
    const directory = runtimeDiagnosticsDirectory(root);
    const diagnostics = new RuntimeDiagnostics(directory);
    diagnostics.ensureDirectory();
    diagnostics.record("app.start");
    const valid = readFileSync(join(directory, "runtime.log"), "utf8").trim();
    const signedRecord = (record: Record<string, unknown>): string => {
      const payload = JSON.stringify(Object.fromEntries(
        Object.entries(record).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0),
      ));
      return JSON.stringify({
        ...record,
        recordDigest: createHash("sha256").update(payload).digest("hex"),
      });
    };
    const strictButUnsafe = signedRecord({
      schemaVersion: 1,
      at: new Date().toISOString(),
      event: "runtime.state",
      phase: "prompt=TOP_SECRET /mnt/customer/roadmap.txt",
    });
    writeFileSync(
      join(directory, "runtime.log"),
      [
        "not-json",
        JSON.stringify({ at: new Date().toISOString(), event: "provider.output", message: "secret output" }),
        JSON.stringify({ at: "invalid", event: "app.start" }),
        JSON.stringify({ at: new Date().toISOString(), event: "app.start" }),
        strictButUnsafe,
        JSON.stringify({
          ...JSON.parse(valid),
          event: "runtime.state",
        }),
        signedRecord({
          schemaVersion: 1,
          at: new Date().toISOString(),
          event: "app.start",
          prompt: "TOP_SECRET",
        }),
        valid,
      ].join("\n"),
      { mode: 0o600 },
    );

    const report = diagnostics.supportReport({
      version: "0.0.10",
      platform: "linux",
      architecture: "x64",
      runtime: null,
    });
    expect(report.eventCount).toBe(1);
    expect(report.text).toContain("app.start");
    expect(report.text).not.toContain("provider.output");
    expect(report.text).not.toContain("secret output");
    expect(report.text).not.toContain("TOP_SECRET");
    expect(report.text).not.toContain("roadmap.txt");
  });

  it("keeps long-session support summaries to the newest bounded lifecycle window", () => {
    const root = fixture();
    const diagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(root), {
      maxFileBytes: 4 * 1_024 * 1_024,
    });
    for (let generation = 1; generation <= 500; generation += 1) {
      diagnostics.record("runtime.state", {
        phase: "ready",
        generation,
        restartAttempt: 0,
      });
    }

    const report = diagnostics.supportReport({
      version: "0.0.10",
      platform: "linux",
      architecture: "x64",
      runtime: null,
    });

    expect(report.eventCount).toBe(120);
    expect(report.text).toContain("generation=500");
    expect(report.text).toContain("generation=381");
    expect(report.text).not.toContain("generation=380 ·");
    expect(Buffer.byteLength(report.text)).toBeLessThanOrEqual(64 * 1_024);
  });

  it("includes only the strict lifecycle and handoff projection in support reports", () => {
    const root = fixture();
    const diagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(root));
    const report = diagnostics.supportReport({
      version: "0.0.10",
      platform: "linux",
      architecture: "x64",
      lifecycle: {
        schemaVersion: 1,
        capturedAt: "2030-01-01T00:00:05.000Z",
        runtimeStartedAt: "2030-01-01T00:00:00.000Z",
        runtimeUptimeMs: 5_000,
        runtimeGenerationHash: "123456789abc",
        buildMetadata: null,
        systemBootRelationship: "current",
        startupBlockerCodes: ["provider-cleanup-pending"],
        quarantineReason: null,
        cleanupProofMethod: "current-generation-lease",
        ownedResources: {
          providerRuns: 1,
          turns: 1,
          terminals: 0,
          workspaceRuns: 0,
          interactions: 1,
          maintenanceOperations: 0,
        },
        activeProviders: [{
          providerId: "codex",
          harnessId: "codex-app-server",
          version: "1.2.3",
          capabilityManifestDigest: "a".repeat(64),
          installationVerified: true,
          maintenanceState: "idle",
        }],
        providerMaintenance: [],
        updateHandoffPhase: null,
        unresolvedTurnCount: 1,
        unresolvedInteractionCount: 1,
        actionableState: "waiting-for-provider-cleanup",
      },
      updateHandoff: {
        state: "active",
        phase: "candidate-bootstrap-validated",
        platform: "linux",
        channel: "stable",
        oldVersion: "0.0.9",
        newVersion: "0.0.10",
        operationTag: "operation-safe-tag",
        oldRuntimeGenerationTag: "generation-safe-tag",
        revision: 3,
        createdAt: "2030-01-01T00:00:00.000Z",
        deadlineAt: "2030-01-01T01:00:00.000Z",
        transitionedAt: "2030-01-01T00:00:04.000Z",
        expired: false,
      },
      updatePreparation: {
        phase: "blocked",
        blocker: "active-work",
      },
      buildMetadata: {
        source: "github-actions",
        sourceRevision: "b".repeat(40),
        runId: "1234567890",
        runAttempt: 2,
        releaseTag: "v0.0.10",
      },
      runtime: {
        phase: "ready",
        generation: 1,
        pid: 1234,
        websocketUrl: "ws://127.0.0.1:1234/runtime-capability",
        runtimeGenerationHash: "123456789abc",
        restartAttempt: 0,
        restartScheduled: false,
        lastError: null,
        startupBlockerCode: null,
      },
    });

    expect(report.text).toContain("Lifecycle state: waiting-for-provider-cleanup");
    expect(report.text).toContain("Runtime generation hash: 123456789abc");
    expect(report.text).toContain("codex/codex-app-server@1.2.3");
    expect(report.text).toContain(
      `Build metadata: github-actions revision=${"b".repeat(40)} run=1234567890 attempt=2 release=v0.0.10`,
    );
    expect(report.text).toContain(
      "Update preparation: blocked blocker=active-work",
    );
    expect(report.text).toContain("Update handoff: candidate-bootstrap-validated");
    expect(report.text).not.toContain("operation-safe-tag");
    expect(report.text).not.toContain("generation-safe-tag");
  });

  it("drops malformed update and build diagnostic objects", () => {
    const root = fixture();
    const diagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(root));
    const report = diagnostics.supportReport({
      version: "0.0.10",
      platform: "linux",
      architecture: "x64",
      runtime: null,
      updatePreparation: {
        phase: "blocked",
        blocker: "prompt=/home/person/private",
      } as never,
      buildMetadata: {
        source: "github-actions",
        sourceRevision: "secret=/home/person/private",
        runId: "private-run",
        runAttempt: 1,
        releaseTag: null,
      } as never,
    });

    expect(report.text).toContain("Build metadata: unavailable");
    expect(report.text).toContain("Update preparation: unavailable");
    expect(report.text).not.toContain("person");
    expect(report.text).not.toContain("private-run");
  });

  it("omits arbitrary state messages from both new logs and support summaries", () => {
    const root = fixture();
    const diagnostics = new RuntimeDiagnostics(runtimeDiagnosticsDirectory(root), {
      maxFileBytes: 4 * 1_024 * 1_024,
    });
    for (let generation = 1; generation <= 120; generation += 1) {
      diagnostics.record("runtime.state", {
        phase: "ready",
        generation,
        message: "🌟".repeat(400),
      });
    }

    const report = diagnostics.supportReport({
      version: "0.0.10",
      platform: "darwin",
      architecture: "arm64",
      runtime: null,
    });

    expect(report.eventCount).toBeGreaterThan(0);
    expect(report.eventCount).toBe(120);
    expect(Buffer.byteLength(report.text, "utf8")).toBeLessThanOrEqual(64 * 1_024);
    expect(report.text).not.toContain("\uFFFD");
    expect(report.text).not.toContain("🌟");
    expect(report.text).toContain("generation=120");
    expect(report.text).not.toContain("generation=1 ·");
    expect(report.text).toContain("Recent lifecycle events (120):");
    expect(report.text).toContain("Privacy: prompts, source, project paths");
  });
});
