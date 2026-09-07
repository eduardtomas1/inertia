import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeNativePhaseScratch } from "../../src/node/runtime-owned-process-native-scratch";

describe.skipIf(process.platform !== "darwin")("scratch native guardian observation", () => {
  let root: string;
  let home: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "inertia-native-phase-test-"));
    home = join(root, "provider-home");
    mkdirSync(home, { mode: 0o700 });
    path = join(home, ".inertia-native-phase-scratch.jsonl");
    writeFileSync(path, "", { mode: 0o600 });
    vi.stubEnv("HOME", home);
    vi.stubEnv("NODE_ENV", "test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  function fixture(command = "/usr/bin/git") {
    const stderr = new PassThrough();
    const child = {
      stderr, stdout: new PassThrough(), spawnargs: ["/guardian", "watch", "123", "--", command, "private-argument"],
    };
    return { stderr, finish: observeNativePhaseScratch(child) };
  }
  it("captures split allowlisted markers without changing existing stderr consumers", () => {
    const { stderr, finish } = fixture();
    let original = "";
    stderr.on("data", (chunk: Buffer) => { original += String(chunk); });
    stderr.write("private-output[Inertia guardian cleanup unproved: term-");
    stderr.write("fork-taint/none]\r\n");
    stderr.write("[Inertia guardian observer taint: note-fork]\r\n");
    finish(null, "SIGUSR2", true);
    expect(original).toContain("private-output");
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain("private");
    expect(JSON.parse(saved)).toMatchObject({
      kind: "git", stopRequested: true, signal: "SIGUSR2", code: null,
      failure: { phase: "term-fork-taint", census: "none" },
      observer: "note-fork",
    });
    expect(stderr.listenerCount("data")).toBe(1);
  });
  it("ignores unknown codes and retains only the first allowlisted marker", () => {
    const { stderr, finish } = fixture("/fixture/kimi");
    stderr.write("[Inertia guardian cleanup unproved: private/none]");
    stderr.write("[Inertia guardian cleanup unproved: drain-census/session-status-unreadable]");
    stderr.write("[Inertia guardian cleanup unproved: drain-timeout/none]");
    finish(null, "SIGUSR2", false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      kind: "provider", stopRequested: false,
      failure: { phase: "drain-census", census: "session-status-unreadable" },
    });
  });
  it("does not enable observation without the precreated synthetic sentinel", () => {
    rmSync(path);
    const { stderr, finish } = fixture();
    expect(stderr.listenerCount("data")).toBe(0);
    finish(0, null, false);
    expect(() => statSync(path)).toThrow();
  });
  it("bounds file output and does not throw when the fixture disappears", () => {
    const { stderr, finish } = fixture();
    stderr.write("x".repeat(65_537));
    writeFileSync(path, "x".repeat(16_384));
    finish(0, null, false);
    expect(statSync(path).size).toBe(16_384);
    rmSync(path);
    expect(() => finish(0, null, false)).not.toThrow();
  });
});
