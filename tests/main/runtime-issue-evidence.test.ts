import { describe, expect, it, vi } from "vitest";

import { runtimeIssueEvidenceBroker } from "../../src/main/runtime-issue-evidence-broker";
import { RuntimeIssueEvidenceCoordinator } from "../../src/main/runtime-issue-evidence-coordinator";
import { isRuntimeSecureFileBrokerEvent, RuntimeSecureFileCoordinator } from "../../src/main/runtime-secure-file-coordinator";
import type { RuntimeProcessRecord } from "../../src/main/runtime-supervisor-types";
import {
  ISSUE_DIAGNOSTICS_MAX_BYTES,
  parseRuntimeIssueEvidenceRequest,
  parseRuntimeIssueEvidenceResult,
} from "../../src/node/runtime-issue-evidence-protocol";
import { parseRuntimeWorkerCommand, parseRuntimeWorkerEvent, type RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { RuntimeIssueEvidenceBrokerClient } from "../../src/server/runtime/issue-evidence-broker-client";

const requestId = "11111111-1111-4111-8111-111111111111";
const evidence = { channel: "stable" as const, osVersion: "15.1.0", diagnostics: "incident app.runtime.crash x1" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe("issue evidence protocol", () => {
  it("accepts only the exact request and bounded result shapes", () => {
    const request = { type: "runtime.issue-evidence-request", requestId, attachDiagnostics: true };
    expect(parseRuntimeIssueEvidenceRequest(request)).toEqual(request);
    expect(parseRuntimeWorkerEvent(request)).toEqual(request);
    expect(parseRuntimeIssueEvidenceRequest({ ...request, diagnostics: "renderer text" })).toBeNull();
    expect(parseRuntimeIssueEvidenceRequest({ ...request, attachDiagnostics: "yes" })).toBeNull();
    expect(parseRuntimeIssueEvidenceRequest({ ...request, requestId: "not-a-uuid" })).toBeNull();
    const result = { type: "runtime.issue-evidence-result", requestId, ok: true, evidence };
    expect(parseRuntimeIssueEvidenceResult(result)).toEqual(result);
    expect(parseRuntimeWorkerCommand(result)).toEqual(result);
    expect(parseRuntimeWorkerCommand({ type: "runtime.issue-evidence-result", requestId, ok: false })).toEqual({ type: "runtime.issue-evidence-result", requestId, ok: false });
    for (const invalid of [
      { ...evidence, diagnostics: "x".repeat(ISSUE_DIAGNOSTICS_MAX_BYTES + 1) },
      { ...evidence, osVersion: "15.1\n/Users/private" },
      { ...evidence, channel: "nightly" },
      { ...evidence, path: "/Users/private" },
    ]) expect(parseRuntimeIssueEvidenceResult({ ...result, evidence: invalid })).toBeNull();
  });
});

describe("main issue evidence broker", () => {
  it("exports diagnostics from the last 24 hours only when the report asks for them", async () => {
    const exportDiagnostics = vi.fn(async () => "incident app.runtime.crash x1\u0007");
    const broker = runtimeIssueEvidenceBroker({ channel: "canary", now: () => 90_000_000, systemVersion: () => "15.1.0", exportDiagnostics });
    await expect(broker.collect({ attachDiagnostics: false })).resolves.toEqual({ channel: "canary", osVersion: "15.1.0", diagnostics: "" });
    expect(exportDiagnostics).not.toHaveBeenCalled();
    await expect(broker.collect({ attachDiagnostics: true })).resolves.toEqual({ channel: "canary", osVersion: "15.1.0", diagnostics: "incident app.runtime.crash x1" });
    expect(exportDiagnostics).toHaveBeenCalledWith({ sinceMs: 90_000_000 - 24 * 60 * 60 * 1_000, maxBytes: ISSUE_DIAGNOSTICS_MAX_BYTES });
  });

  it("bounds an oversized export and drops an unrecognised OS version", async () => {
    const broker = runtimeIssueEvidenceBroker({ channel: "stable", systemVersion: () => "15.1\n/Users/private", exportDiagnostics: async () => "é".repeat(ISSUE_DIAGNOSTICS_MAX_BYTES) });
    const collected = await broker.collect({ attachDiagnostics: true });
    expect(collected.osVersion).toBeNull();
    expect(Buffer.byteLength(collected.diagnostics)).toBeLessThanOrEqual(ISSUE_DIAGNOSTICS_MAX_BYTES);
    expect(parseRuntimeIssueEvidenceResult({ type: "runtime.issue-evidence-result", requestId, ok: true, evidence: collected })).not.toBeNull();
  });
});

describe("main issue evidence coordinator", () => {
  it("answers one request per identity and suppresses late replies after the runtime is cleared", async () => {
    const pending = deferred<typeof evidence>();
    let signal: AbortSignal | undefined;
    const broker = { collect: vi.fn(async (_request: { attachDiagnostics: boolean }, candidate: AbortSignal) => { signal = candidate; return await pending.promise; }) };
    const post = vi.fn();
    const peer = {} as RuntimeProcessRecord;
    const coordinator = new RuntimeIssueEvidenceCoordinator({ broker, accepts: () => true, post });
    const event = { type: "runtime.issue-evidence-request" as const, requestId, attachDiagnostics: true };
    coordinator.handle(peer, event);
    coordinator.handle(peer, event);
    expect(post).toHaveBeenCalledWith(peer, { type: "runtime.issue-evidence-result", requestId, ok: false });
    expect(broker.collect).toHaveBeenCalledWith({ attachDiagnostics: true }, expect.any(AbortSignal));
    coordinator.clear(peer);
    expect(signal?.aborted).toBe(true);
    pending.resolve(evidence);
    await new Promise((resolve) => setImmediate(resolve));
    expect(post).toHaveBeenCalledOnce();
  });

  it("replies with evidence, and refuses without a broker or for a rejected runtime", async () => {
    const post = vi.fn();
    const peer = {} as RuntimeProcessRecord;
    const coordinator = new RuntimeIssueEvidenceCoordinator({ broker: { collect: async () => evidence }, accepts: () => true, post });
    coordinator.handle(peer, { type: "runtime.issue-evidence-request", requestId, attachDiagnostics: false });
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(peer, { type: "runtime.issue-evidence-result", requestId, ok: true, evidence }));
    const refused = vi.fn();
    new RuntimeIssueEvidenceCoordinator({ accepts: () => true, post: refused }).handle(peer, { type: "runtime.issue-evidence-request", requestId, attachDiagnostics: true });
    new RuntimeIssueEvidenceCoordinator({ broker: { collect: async () => evidence }, accepts: () => false, post: refused }).handle(peer, { type: "runtime.issue-evidence-request", requestId, attachDiagnostics: true });
    expect(refused.mock.calls).toEqual([[peer, { type: "runtime.issue-evidence-result", requestId, ok: false }], [peer, { type: "runtime.issue-evidence-result", requestId, ok: false }]]);
  });
});

describe("runtime broker routing", () => {
  it("routes issue evidence requests through the broker coordinator and aborts them when the runtime is cleared", async () => {
    const event = { type: "runtime.issue-evidence-request" as const, requestId, attachDiagnostics: true };
    expect(isRuntimeSecureFileBrokerEvent(event)).toBe(true);
    let signal: AbortSignal | undefined;
    const post = vi.fn();
    const peer = { secureFileRequestIds: new Set() } as unknown as RuntimeProcessRecord;
    const coordinator = new RuntimeSecureFileCoordinator({
      issueEvidenceBroker: { collect: (_request, candidate) => { signal = candidate; return new Promise(() => undefined); } },
      accepts: () => true,
      post,
    });
    coordinator.handle(peer, event);
    expect(signal?.aborted).toBe(false);
    coordinator.clear(peer);
    expect(signal?.aborted).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("runtime issue evidence client", () => {
  it("sends only the boolean and resolves the correlated evidence once", async () => {
    const events: RuntimeWorkerEvent[] = [];
    const client = new RuntimeIssueEvidenceBrokerClient((event) => events.push(event), 1_000);
    const result = client.collect(true);
    expect(events).toEqual([{ type: "runtime.issue-evidence-request", requestId: expect.any(String), attachDiagnostics: true }]);
    const reply = { type: "runtime.issue-evidence-result" as const, requestId: (events[0] as { requestId: string }).requestId, ok: true as const, evidence };
    expect(client.handle(reply)).toBe(true);
    await expect(result).resolves.toEqual(evidence);
    expect(client.handle(reply)).toBe(false);
  });

  it("settles to null on failure, timeout and close", async () => {
    vi.useFakeTimers();
    try {
      const events: RuntimeWorkerEvent[] = [];
      const client = new RuntimeIssueEvidenceBrokerClient((event) => events.push(event), 1_000);
      const failed = client.collect(false);
      client.handle({ type: "runtime.issue-evidence-result", requestId: (events[0] as { requestId: string }).requestId, ok: false });
      await expect(failed).resolves.toBeNull();
      const timedOut = client.collect(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(timedOut).resolves.toBeNull();
      const closed = client.collect(true);
      client.close();
      await expect(closed).resolves.toBeNull();
      await expect(client.collect(true)).resolves.toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
