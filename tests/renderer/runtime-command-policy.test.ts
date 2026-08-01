import { describe, expect, it } from "vitest";

import {
  AGENT_WORKFLOW_REQUEST_TIMEOUT_MS,
  BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS,
  CONVERSATION_DETAIL_REQUEST_TIMEOUT_MS,
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
  RUNTIME_COMMAND_POLICIES,
  runtimeCommandPolicy,
} from "../../src/renderer/src/utils/runtimeCommandPolicy";

describe("runtime command delivery policy", () => {
  it("classifies representative reads and idempotent refreshes as retry-safe", () => {
    expect(runtimeCommandPolicy("app.refresh")).toEqual({
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
  });

  it("assigns an explicit supported timeout-delivery state to every mapped command", () => {
    expect(Object.values(RUNTIME_COMMAND_POLICIES).every(
      ({ timeoutDelivery }) => timeoutDelivery === "rejected" || timeoutDelivery === "ambiguous",
    )).toBe(true);
  });

  it("keeps renderer deadlines beyond authoritative aggregate server bounds", () => {
    expect(GIT_READ_REQUEST_TIMEOUT_MS)
      .toBeGreaterThan(GIT_READ_OPERATION_TIMEOUT_MS);
    expect(WORKSPACE_GIT_REFRESH_REQUEST_TIMEOUT_MS)
      .toBeGreaterThan(WORKSPACE_GIT_DISCOVERY_TIMEOUT_MS);
  });
});
