import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { ClientCommand } from "../../src/shared/contracts";
import type { IncidentObservation } from "../../src/node/application-incidents";
import { CommandIncidents, stableCommandIncidentId } from "../../src/server/runtime/command-incidents";

const projectId = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222:3";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function command(type: string, payload: Record<string, unknown> = { projectId }): ClientCommand {
  return { requestId: randomUUID(), type, payload } as unknown as ClientCommand;
}

function requestError(command: ClientCommand) {
  return { type: "request.error" as const, requestId: command.requestId, message: "Failed." };
}

describe("command incidents", () => {
  it("gives repeated failures of one operation the same identity so they aggregate", () => {
    const sink = vi.fn<(observation: IncidentObservation) => unknown>();
    const incidents = new CommandIncidents(sink, generation);
    const first = command("git.status");
    const second = command("git.status");
    const diagnosticIds = [first, second].map((entry) =>
      incidents.run(entry, () => incidents.observe(requestError(entry))))
      .map((event) => (event as { diagnosticId?: string }).diagnosticId);
    expect(diagnosticIds[0]).toMatch(uuid);
    expect(diagnosticIds[1]).toBe(diagnosticIds[0]);
    expect(sink).toHaveBeenCalledTimes(2);
    // Each occurrence still names its own request; the identity is shared.
    expect(sink.mock.calls.map(([observation]) => observation)).toEqual([
      expect.objectContaining({ id: diagnosticIds[0], correlationId: first.requestId,
        code: "git.command-failed", outcome: "unknown", context: { projectId, requestId: first.requestId } }),
      expect.objectContaining({ id: diagnosticIds[0], correlationId: second.requestId,
        context: { projectId, requestId: second.requestId } }),
    ]);
    // A different project, command or generation is a different incident.
    expect(stableCommandIncidentId(generation, "git.command-failed", "git.status", { projectId: randomUUID() }))
      .not.toBe(diagnosticIds[0]);
    expect(stableCommandIncidentId(generation, "git.command-failed", "git.commit", { projectId }))
      .not.toBe(diagnosticIds[0]);
    expect(stableCommandIncidentId(null, "git.command-failed", "git.status", { projectId }))
      .not.toBe(diagnosticIds[0]);
  });

  it("collapses a subsystem report and the request error of one operation into one incident", () => {
    const sink = vi.fn<(observation: IncidentObservation) => unknown>();
    const incidents = new CommandIncidents(sink, generation);
    const outer = command("git.pull");
    incidents.run(outer, () => {
      // The Git subsystem reports its own failure while the command runs...
      incidents.report({ code: "git.command-failed", outcome: "unknown", context: { projectId } });
      // ...and a nested command dispatched inside it is the same operation.
      incidents.run(command("git.status"), () => incidents.observe(requestError(command("git.status"))));
      return incidents.observe(requestError(outer));
    });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toMatchObject({
      code: "git.command-failed", outcome: "unknown", correlationId: outer.requestId,
      context: { projectId, requestId: outer.requestId },
    });
  });

  it("leaves observations outside an operation and unrelated codes untouched", () => {
    const sink = vi.fn<(observation: IncidentObservation) => unknown>();
    const incidents = new CommandIncidents(sink, generation);
    incidents.report({ code: "git.command-failed", outcome: "unknown", context: { projectId } });
    expect(sink.mock.calls[0]![0]).toEqual({ code: "git.command-failed", outcome: "unknown", context: { projectId } });
    incidents.run(command("settings.update", {}), () => {
      incidents.report({ code: "git.command-failed", outcome: "unknown", context: { projectId } });
    });
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]![0]).toEqual({ code: "git.command-failed", outcome: "unknown", context: { projectId } });
  });
});
