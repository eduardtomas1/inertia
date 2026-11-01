// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import type { AppSnapshot, ClientCommand } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { RUNTIME_COMMAND_TYPES } from "../../src/server/runtime/commands/command-router";
import { runtimeSafetyAllowsCommand } from "../../src/server/runtime/commands/runtime-safety";
import {
  detachedChatCommandRejection,
  type DetachedChatRuntimePolicyResources,
} from "../../src/server/runtime/detached-chat-runtime-policy";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TASK = "a".repeat(64);
const OTHER_TASK = "b".repeat(64);
const REQUEST = "33333333-3333-4333-8333-333333333333";
const authority = { kind: "detached-chat" as const, conversationId: CONVERSATION, clientId: "window-1" };

const resources: DetachedChatRuntimePolicyResources = {
  snapshot: () => ({ conversations: [{ id: CONVERSATION, projectId: "project" }] }) as unknown as AppSnapshot,
  subagentConversationId: () => null,
  checkpointConversationId: () => null,
  turnConversationId: () => null,
  duoLaunchConversationIds: () => null,
  delegatedTaskConversationIds: (taskId) => taskId === TASK ? [OTHER, CONVERSATION] : taskId === OTHER_TASK ? [OTHER] : null,
  pendingApproval: () => null,
  pendingInput: () => null,
};

const command = (value: Record<string, unknown>): ClientCommand => clientCommandSchema.parse({ requestId: REQUEST, ...value });

describe("delegation and observed-child command policy", () => {
  it("parses exactly the delegation commands and registers them with the runtime", () => {
    const types = ["delegation.task.read", "delegation.task.cancel", "delegation.delivery.dismiss", "delegation.delivery.send",
      "delegation.wake.set", "observed-child.read"] as const;
    expect(types.every((type) => RUNTIME_COMMAND_TYPES.includes(type))).toBe(true);
    expect(types.filter(runtimeSafetyAllowsCommand)).toEqual([]);
    expect(() => command({ type: "delegation.task.cancel", payload: { taskId: "not-a-task" } })).toThrow();
    expect(() => command({ type: "delegation.delivery.dismiss", payload: { parentConversationId: CONVERSATION,
      taskIds: [TASK, TASK] } })).toThrow();
    expect(() => command({ type: "delegation.wake.set", payload: { taskId: TASK, armed: true, extra: 1 } })).toThrow();
  });

  it("lets a detached window read its own chat's tasks and agents but sends every mutation to the main window", () => {
    const reject = (value: Record<string, unknown>) => detachedChatCommandRejection(authority, command(value), resources);
    expect(reject({ type: "delegation.task.read", payload: { taskId: TASK } })).toBeNull();
    expect(reject({ type: "delegation.task.read", payload: { taskId: OTHER_TASK } })).not.toBeNull();
    expect(reject({ type: "delegation.task.read", payload: { taskId: "c".repeat(64) } })).not.toBeNull();
    expect(reject({ type: "observed-child.read", payload: { conversationId: CONVERSATION } })).toBeNull();
    expect(reject({ type: "observed-child.read", payload: { conversationId: OTHER } })).not.toBeNull();
    for (const mutation of [
      { type: "delegation.task.cancel", payload: { taskId: TASK } },
      { type: "delegation.delivery.dismiss", payload: { parentConversationId: CONVERSATION } },
      { type: "delegation.delivery.send", payload: { parentConversationId: CONVERSATION } },
      { type: "delegation.wake.set", payload: { taskId: TASK, armed: false } },
    ]) expect(reject(mutation)).not.toBeNull();
  });
});
