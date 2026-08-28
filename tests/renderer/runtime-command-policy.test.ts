import { describe, expect, it } from "vitest";

import {
  AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
  BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS,
  CONVERSATION_DETAIL_REQUEST_TIMEOUT_MS,
  DUO_CANCEL_REQUEST_TIMEOUT_MS,
  DUO_DISPATCH_REQUEST_TIMEOUT_MS,
  GIT_MUTATION_REQUEST_TIMEOUT_MS,
  GIT_READ_OPERATION_TIMEOUT_MS,
  GIT_READ_REQUEST_TIMEOUT_MS,
  MESSAGE_SEND_REQUEST_TIMEOUT_MS,
  WORKSPACE_ENTRY_REQUEST_TIMEOUT_MS,
  WORKSPACE_FILE_REQUEST_TIMEOUT_MS,
  WORKSPACE_GIT_DISCOVERY_TIMEOUT_MS,
  WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS,
} from "../../src/shared/runtime-command-timeouts";
import {
  publishesWorkspaceGitCompletion,
  RUNTIME_COMMAND_POLICIES,
  runtimeCommandPolicy,
} from "../../src/renderer/src/utils/runtimeCommandPolicy";
import { commandRefreshesConversationDetail } from "../../src/renderer/src/lib/runtimeCommands";

describe("runtime command delivery policy", () => {
  it("classifies representative reads and idempotent refreshes as retry-safe", () => {
    expect(runtimeCommandPolicy("app.refresh")).toEqual({
      timeoutMs: 15_000,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("usage.dashboard.get")).toEqual({
      timeoutMs: 15_000,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("conversation.detail.load")).toEqual({
      timeoutMs: CONVERSATION_DETAIL_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("git.workspace.refresh")).toEqual({
      timeoutMs: WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("git.diff")).toEqual({
      timeoutMs: GIT_READ_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("git.pr.confidence")).toEqual({
      timeoutMs: GIT_READ_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("workspace.file.read")).toEqual({
      timeoutMs: WORKSPACE_FILE_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("workspace.entries")).toEqual({
      timeoutMs: WORKSPACE_ENTRY_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("agent.skills.list")).toEqual({
      timeoutMs: AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "rejected",
    });
  });

  it("classifies representative mutations as ambiguous with their existing deadlines", () => {
    expect(runtimeCommandPolicy("terminal.attach")).toEqual({
      timeoutMs: 15_000,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("terminal.input")).toEqual({
      timeoutMs: 15_000,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("git.selection.revert")).toEqual({
      timeoutMs: GIT_MUTATION_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("backend.profile.probe")).toEqual({
      timeoutMs: BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("message.send")).toEqual({
      timeoutMs: MESSAGE_SEND_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("duo.prepare")).toEqual({
      timeoutMs: GIT_MUTATION_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("duo.dispatch")).toEqual({
      timeoutMs: DUO_DISPATCH_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("duo.cancel")).toEqual({
      timeoutMs: DUO_CANCEL_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("duo.acknowledge")).toEqual({
      timeoutMs: DUO_CANCEL_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("duo.status")).toEqual({
      timeoutMs: 15_000,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("duo.pending")).toEqual({
      timeoutMs: 15_000,
      timeoutDelivery: "rejected",
    });
    expect(runtimeCommandPolicy("duo.comparison.retry")).toEqual({
      timeoutMs: 15_000,
      timeoutDelivery: "ambiguous",
    });
    expect(runtimeCommandPolicy("duo.comparison.cancel")).toEqual({
      timeoutMs: DUO_CANCEL_REQUEST_TIMEOUT_MS,
      timeoutDelivery: "ambiguous",
    });
  });

  it("assigns an explicit supported timeout-delivery state to every mapped command", () => {
    expect(Object.values(RUNTIME_COMMAND_POLICIES).every(
      ({ timeoutDelivery }) => timeoutDelivery === "rejected" || timeoutDelivery === "ambiguous",
    )).toBe(true);
  });

  it("refreshes packet summaries after draft context changes", () => {
    const targetConversationId = "22222222-2222-4222-8222-222222222222";
    expect(commandRefreshesConversationDetail({
      type: "conversation.context.create",
      payload: {
        sourceConversationId: "11111111-1111-4111-8111-111111111111",
        targetConversationId,
        sourceMessageIds: ["33333333-3333-4333-8333-333333333333"],
        acknowledgedWorkspaceDifference: false,
      },
    })).toBe(true);
    expect(commandRefreshesConversationDetail({
      type: "conversation.context.remove",
      payload: {
        packetId: "44444444-4444-4444-8444-444444444444",
        targetConversationId,
      },
    })).toBe(true);
  });

  it("identifies mutations with durable Git completion publication", () => {
    expect(publishesWorkspaceGitCompletion("git.branch.switch")).toBe(true);
    expect(publishesWorkspaceGitCompletion("git.selection.undo")).toBe(true);
    expect(publishesWorkspaceGitCompletion("git.selection.inspect")).toBe(false);
    expect(publishesWorkspaceGitCompletion("checkpoint.revert")).toBe(false);
  });

  it("keeps renderer deadlines beyond authoritative aggregate server bounds", () => {
    expect(GIT_READ_REQUEST_TIMEOUT_MS)
      .toBeGreaterThan(GIT_READ_OPERATION_TIMEOUT_MS);
    expect(WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS)
      .toBeGreaterThan(WORKSPACE_GIT_DISCOVERY_TIMEOUT_MS);
  });
});
