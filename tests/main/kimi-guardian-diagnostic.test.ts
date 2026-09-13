import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeKimiGuardianDiagnostics, guardianFailureReason,
  KIMI_GUARDIAN_DIAGNOSTIC_PREFIX as prefix, observeKimiGuardianFailure,
  noteKimiGuardianGitOperation, parseKimiGuardianDiagnostic } from "../../src/node/kimi-guardian-diagnostic";

const state = { event: "runtime-state", at: 1, generation: 1, phase: "starting",
  restartAttempt: 0, elapsedMs: 2, sequence: 3, observerPid: 4 };
const failure = { event: "guardian-close", at: 1, cleanupReason: "drain-fork-taint",
  censusReason: "none", probe: "git", signal: "SIGUSR2", exitCode: null,
  elapsedMs: 2, sequence: 3, observerPid: 4, operation: "apple-git-selection",
  stopRequested: false, admissionSucceeded: true, authorizationObserved: true };

describe("nonshipping Kimi guardian diagnostics", () => {
  beforeEach(() => { vi.stubEnv("INERTIA_DIAG_KIMI_GUARDIAN", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it("accepts only native fixed reason pairs", () => {
    expect(guardianFailureReason("\r[Inertia guardian cleanup unproved: freeze-initial-census/session-live-identity-unreadable]\r"))
      .toEqual({ cleanupReason: "freeze-initial-census", censusReason: "session-live-identity-unreadable" });
    expect(guardianFailureReason("[Inertia guardian cleanup unproved: private-secret/none]")).toBeNull();
    expect(guardianFailureReason("PRIVATE [Inertia guardian cleanup unproved: drain-timeout/none]")).toBeNull();
  });
  it("round trips only the two fixed schemas", () => {
    expect(parseKimiGuardianDiagnostic(prefix + JSON.stringify(state))).toEqual(state);
    expect(parseKimiGuardianDiagnostic(prefix + JSON.stringify(failure))).toEqual(failure);
  });
  it("rejects private fields and malformed values", () => {
    for (const value of [{ ...failure, args: ["PRIVATE"] }, { ...failure, probe: "PRIVATE" },
      { ...failure, cleanupReason: ["drain-timeout"] }, { ...failure, signal: "PRIVATE" },
      { ...failure, exitCode: 256 }, { ...state, generation: -1 }, { ...state, phase: "PRIVATE" }]) {
      expect(parseKimiGuardianDiagnostic(prefix + JSON.stringify(value))).toBeNull();
    }
  });
  it("handles split records while dropping unrelated output", () => {
    const seen = vi.fn();
    const consume = consumeKimiGuardianDiagnostics(seen);
    const line = prefix + JSON.stringify(state) + "\n";
    consume(Buffer.from("PRIVATE\n" + line.slice(0, 20)));
    consume(Buffer.from(line.slice(20)));
    expect(seen).toHaveBeenCalledExactlyOnceWith(state);
  });
  it("recovers after oversized unrelated lines without forwarding them", () => {
    const seen = vi.fn();
    const consume = consumeKimiGuardianDiagnostics(seen);
    consume(Buffer.from("PRIVATE".repeat(10_000) + "\n"));
    consume(Buffer.from(prefix + JSON.stringify(state) + "\n"));
    expect(seen).toHaveBeenCalledExactlyOnceWith(state);
  });
  it("emits only abnormal close with claim hints and removes its listener", () => {
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stderr,
      spawnargs: ["guardian", "watch", "123", "--", "/usr/bin/xcrun", "--find", "git"] }) as unknown as ChildProcess;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const claim = { stopRequested: false, admissionSucceeded: true, authorizationObserved: true };
      observeKimiGuardianFailure(child, "git", claim);
      noteKimiGuardianGitOperation(child, true);
      stderr.write("PRIVATE\n[Inertia guardian cleanup unproved: drain-fork-");
      stderr.write("taint/none]\r\n");
      claim.stopRequested = true;
      child.emit("close", null, "SIGUSR2");
      expect(log).toHaveBeenCalledOnce();
      const parsed = parseKimiGuardianDiagnostic(String(log.mock.calls[0]![0]));
      expect(parsed).toMatchObject({ ...failure, stopRequested: true,
        at: expect.any(Number), elapsedMs: expect.any(Number), sequence: expect.any(Number), observerPid: process.pid });
      expect(stderr.listenerCount("data")).toBe(0);
    } finally { log.mockRestore(); stderr.destroy(); }
  });
  it("does not report a normal payload exit as failed containment", () => {
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stderr, spawnargs: [] }) as unknown as ChildProcess;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      observeKimiGuardianFailure(child, undefined, { stopRequested: false, admissionSucceeded: true, authorizationObserved: true });
      stderr.write("[Inertia guardian cleanup unproved: drain-timeout/none]\n");
      child.emit("close", 1, null);
      expect(log).not.toHaveBeenCalled();
      expect(stderr.listenerCount("data")).toBe(0);
    } finally { log.mockRestore(); stderr.destroy(); }
  });
});
