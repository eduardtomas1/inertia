import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CommandIncidents } from "../../src/server/runtime/command-incidents";
import { ProviderReadinessIncidents } from "../../src/server/provider/readiness-incidents";
import { createIncidentReporter } from "../../src/node/application-incidents";
import type { ClientCommand, ProviderInfo } from "../../src/shared/contracts";

describe("application incident producers", () => {
  it("binds interleaved command failures to their original requests and excludes every payload field", async () => {
    const sink = vi.fn();
    const reporter = createIncidentReporter(sink, `${randomUUID()}:1`);
    const incidents = new CommandIncidents(reporter);
    const authorityRef = randomUUID();
    const first = { type: "git.commit", requestId: randomUUID(), payload: { projectId: randomUUID(), authorityRef, message: "SECRET_COMMIT",
      reviewReceipt: { authorityRef, fingerprint: "a".repeat(64) } } } satisfies ClientCommand;
    const second = { type: "terminal.create", requestId: randomUUID(), payload: { projectId: randomUUID(), cols: 80, rows: 24 } } satisfies ClientCommand;
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstRun = incidents.run(first, async () => {
      await firstWait;
      const response = { type: "request.error" as const, requestId: first.requestId, message: "SECRET_FAILURE" };
      const decorated = incidents.observe(response);
      incidents.observe(response);
      return decorated;
    });
    const secondResult = await incidents.run(second, async () => {
      await Promise.resolve();
      return incidents.observe({ type: "request.error", requestId: second.requestId, message: "PRIVATE_FAILURE" });
    });
    releaseFirst(); const firstResult = await firstRun;
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0]![0]).toMatchObject({ code: "terminal.command-failed", context: { requestId: second.requestId, projectId: second.payload.projectId } });
    expect(sink.mock.calls[1]![0]).toMatchObject({ code: "git.command-failed", context: { requestId: first.requestId, projectId: first.payload.projectId } });
    expect(firstResult).toMatchObject({ diagnosticId: sink.mock.calls[1]![0].id });
    expect(secondResult).toMatchObject({ diagnosticId: sink.mock.calls[0]![0].id });
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/SECRET|PRIVATE/u);
  });

  it("links a propagated request rejection to the original terminal incident", async () => {
    const sink = vi.fn();
    const incidents = new CommandIncidents(createIncidentReporter(sink));
    const turnId = randomUUID(); const projectId = randomUUID();
    const command = { type: "message.send", requestId: randomUUID(), payload: { conversationId: randomUUID(), content: "PRIVATE", attachments: [] } } satisfies ClientCommand;
    const result = await incidents.run(command, async () => {
      await Promise.resolve();
      incidents.report({ code: "turn.failed", outcome: "failed", context: { turnId, projectId } });
      return incidents.observe({ type: "request.error", requestId: command.requestId, message: "PRIVATE" });
    });
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]![0]).toMatchObject({ code: "turn.failed", correlationId: command.requestId,
      context: { turnId, projectId, requestId: command.requestId } });
    expect(result).toMatchObject({ diagnosticId: sink.mock.calls[0]![0].id });
  });

  it("ignores unused uninstalled providers, records authoritative auth failure once, and recovers the same incident", () => {
    const sink = vi.fn();
    const observations = new ProviderReadinessIncidents(createIncidentReporter(sink, `${randomUUID()}:1`));
    const provider = { id: "claude", installState: "not-installed", authState: "unknown", canRun: false, statusMessage: "SECRET" } as ProviderInfo;
    observations.observe([provider]); expect(sink).not.toHaveBeenCalled();
    const failed = { ...provider, installState: "installed" as const, authState: "unauthenticated" as const };
    observations.observe([failed]); observations.observe([failed]);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]![0]).toMatchObject({ code: "provider.auth-failed", outcome: "failed", context: { providerId: "claude" } });
    observations.observe([{ ...failed, authState: "authenticated", canRun: true }]);
    expect(sink.mock.calls[1]![0]).toMatchObject({ id: sink.mock.calls[0]![0].id, outcome: "recovered" });
    expect(JSON.stringify(sink.mock.calls)).not.toContain("SECRET");
  });

  it("never lets malformed observations or a failing sink disrupt command execution", async () => {
    const sink = vi.fn(() => { throw new Error("logging unavailable"); });
    const report = createIncidentReporter(sink);
    expect(() => report({ code: "turn.failed", outcome: "failed" })).not.toThrow();
    expect(report({ code: "turn.failed", outcome: "failed", context: { conversationId: "PRIVATE_PATH" } })).toBeNull();
    expect(sink).toHaveBeenCalledOnce();
    const asynchronous = createIncidentReporter(async () => { throw new Error("disk unavailable"); });
    expect(asynchronous({ code: "turn.failed", outcome: "failed" })).toEqual(expect.any(String));
    await Promise.resolve();
  });
});
