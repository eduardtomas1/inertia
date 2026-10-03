import { describe, expect, it } from "vitest";

import * as attachmentExports from "../src/shared/attachments";
import * as backendProfileExports from "../src/shared/backend-profile-settings";
import * as facadeExports from "../src/shared/contracts";
import * as agentExports from "../src/shared/contracts/agent";
import * as agentWorkflowExports from "../src/shared/contracts/agent-workflows";
import * as appExports from "../src/shared/contracts/app";
import * as clientCommandExports from "../src/shared/contracts/client-command";
import * as conversationContextExports from "../src/shared/conversation-context";
import * as duoExports from "../src/shared/contracts/duo";
import * as eventExports from "../src/shared/contracts/events";
import * as lifecycleDiagnosticExports from "../src/shared/lifecycle-diagnostics";
import * as modelRoutingExports from "../src/shared/model-routing";
import * as providerMaintenanceExports from "../src/shared/provider-maintenance";
import * as providerTerminalResumeExports from "../src/shared/provider-terminal-resume";
import * as runStateExports from "../src/shared/run-state";
import * as usageDashboardExports from "../src/shared/contracts/usage-dashboard";
import * as workspaceExports from "../src/shared/contracts/workspace";
import { clientCommandSchema } from "../src/shared/contracts/client-command";

describe("shared contracts boundary", () => {
  it("keeps the compatibility facade's runtime exports exact", () => {
    const domainExports = {
      ...modelRoutingExports,
      ...backendProfileExports,
      ...attachmentExports,
      ...providerMaintenanceExports,
      ...providerTerminalResumeExports,
      ...runStateExports,
      ...lifecycleDiagnosticExports,
      ...agentExports,
      ...agentWorkflowExports,
      ...appExports,
      ...clientCommandExports,
      ...conversationContextExports,
      ...duoExports,
      ...eventExports,
      ...usageDashboardExports,
      ...workspaceExports,
    };

    expect(Object.keys(facadeExports).sort()).toEqual(Object.keys(domainExports).sort());
    for (const [name, value] of Object.entries(domainExports)) {
      expect(facadeExports[name as keyof typeof facadeExports]).toBe(value);
    }
  });

  it("bounds Duo reconciliation to both sources and one judge project", () => {
    const projectIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const command = (ids: string[]) => ({
      type: "duo.pending",
      requestId: "44444444-4444-4444-8444-444444444444",
      payload: { projectIds: ids },
    });

    expect(clientCommandSchema.safeParse(command(projectIds)).success).toBe(true);
    expect(clientCommandSchema.safeParse(command([
      ...projectIds,
      "55555555-5555-4555-8555-555555555555",
    ])).success).toBe(false);
  });
});

it("requires an explicit acknowledgment for uncertain report retirement", () => {
  const payload = { id: "11111111-1111-4111-8111-111111111111", revision: 3 };
  const command = { type: "support.report.retire", requestId: "22222222-2222-4222-8222-222222222222", payload };
  expect(clientCommandSchema.safeParse(command).success).toBe(false);
  expect(clientCommandSchema.safeParse({ ...command, payload: { ...payload, acknowledgeUncertainPublication: false } }).success).toBe(false);
  expect(clientCommandSchema.safeParse({ ...command, payload: { ...payload, acknowledgeUncertainPublication: true } }).success).toBe(true);
});

it("accepts only opaque project-scoped CLI import grants at the command boundary", () => {
  const command = { type: "conversation.cli.import", requestId: "11111111-1111-4111-8111-111111111111",
    payload: { projectId: "22222222-2222-4222-8222-222222222222", candidateId: "33333333-3333-4333-8333-333333333333", revision: "a".repeat(64) } };
  expect(clientCommandSchema.safeParse(command).success).toBe(true);
  for (const payload of [{ ...command.payload, path: "/private/transcript.jsonl" }, { ...command.payload, sessionId: "forged" },
    { ...command.payload, candidateId: "../escape" }, { ...command.payload, revision: "stale" }]) {
    expect(clientCommandSchema.safeParse({ ...command, payload }).success).toBe(false);
  }
});
