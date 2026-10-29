import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import { AgentSecretService } from "../../src/server/runtime/agent-secrets/agent-secret-service";
import type { TurnSecretOutputFilter } from "../../src/server/runtime/turns/turn-secret-output";
import { SECRET_REQUEST_TOOL_NAME } from "../../src/shared/agent-secrets";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

const SECRET = "tskey-auth-kQ9xZ2mB7vN4pL1sR8tW";

afterEach(cleanupTurnControllerTestDirectories);

function call(signal = new AbortController().signal): ProviderHostToolCall {
  return {
    providerThreadId: "thread",
    providerTurnId: "turn",
    toolCallId: randomUUID(),
    tool: SECRET_REQUEST_TOOL_NAME,
    arguments: { title: "Tailscale auth key", description: "Create a reusable key in the admin console." },
    signal,
    requestApproval: async () => "approve",
  };
}

async function startedTurn() {
  const holder: { filter?: TurnSecretOutputFilter } = {};
  const runtime = await createTurnControllerTestRuntime({ secretOutput: () => holder.filter }, { id: randomUUID });
  const service = new AgentSecretService({
    store: runtime.store,
    dataDirectory: runtime.directory,
    turns: runtime.controller,
    broadcast: (event) => runtime.events.push(event),
    waitMs: () => 60_000,
  });
  service.start();
  holder.filter = service.output;
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Set up the VMs." });
  expect(runtime.controller.start(queued.turn.id)).toBe(true);
  const conversation = runtime.store.conversation(runtime.conversationId);
  const turn = runtime.store.agentTurn(queued.turn.id);
  return { runtime, service, conversation, turn };
}

describe("agent secret requests inside a live turn", () => {
  it("waits for input while the card is pending and returns to running when the value arrives", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Next I need the key." });
      const result = service.invoke({ conversation, turn }, call());
      const [pending] = runtime.store.agentSecretRequests().pendingAll();
      expect(runtime.store.agentTurn(turn.id).status).toBe("waiting-for-input");
      expect(runtime.store.conversation(conversation.id)).toMatchObject({ status: "needs-input", attentionKind: "input" });
      await service.deliver({ conversationId: conversation.id, requestId: pending!.id, secret: SECRET, vaulted: false });
      expect(JSON.parse((await result).text)).toMatchObject({ status: "saved" });
      expect(runtime.store.agentTurn(turn.id).status).toBe("running");
      expect(runtime.store.conversation(conversation.id).status).toBe("running");
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("ends the pending request when the turn is stopped", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const controller = new AbortController();
      const result = service.invoke({ conversation, turn }, call(controller.signal));
      const [pending] = runtime.store.agentSecretRequests().pendingAll();
      expect(runtime.controller.cancel(conversation.id)).toBe(true);
      controller.abort();
      expect(JSON.parse((await result).text)).toMatchObject({ status: "ended", reason: "cancelled" });
      expect(runtime.store.agentSecretRequests().find(pending!.id)?.status).toBe("ended");
    } finally {
      service.shutdown();
      runtime.store.close();
    }
  });

  it("never persists or broadcasts a saved value from streamed text, tool output, activity labels or the final result", async () => {
    const { runtime, service, conversation, turn } = await startedTurn();
    try {
      const result = service.invoke({ conversation, turn }, call());
      const [pending] = runtime.store.agentSecretRequests().pendingAll();
      await service.deliver({ conversationId: conversation.id, requestId: pending!.id, secret: SECRET, vaulted: false });
      await result;
      const identity = turnControllerTestIdentity(runtime);
      runtime.provider.emit({ ...identity, type: "text", text: "The key is tskey-auth-kQ9x", itemId: "a" });
      runtime.provider.emit({ ...identity, type: "text", text: "Z2mB7vN4pL1sR8tW, logging in.", itemId: "a" });
      runtime.provider.emit({
        ...identity, type: "activity", kind: "command", phase: "started", activityId: "cmd-1",
        label: `tailscale up --authkey ${SECRET}`, detail: `tailscale up --authkey ${SECRET}`,
      });
      runtime.provider.emit({
        ...identity, type: "activity", kind: "command", phase: "completed", activityId: "cmd-1",
        label: `tailscale up --authkey ${SECRET}`, outputDelta: `${SECRET}\nok\n`,
      });
      runtime.scheduler.runAll();
      runtime.provider.resolve({ status: "completed", text: `The key is ${SECRET}, logging in.` });
      await flushTurnControllerTestPromises();
      runtime.scheduler.runAll();
      await flushTurnControllerTestPromises();
      const detail = runtime.store.conversationDetail(conversation.id);
      const serializedDetail = JSON.stringify(detail);
      expect(serializedDetail).not.toContain(SECRET);
      expect(serializedDetail).toContain("[redacted]");
      expect(JSON.stringify(runtime.events)).not.toContain(SECRET);
      const assistant = detail?.messages.filter(({ role }) => role === "assistant").map(({ content }) => content).join("\n");
      expect(assistant).toContain("The key is [redacted], logging in.");
      service.shutdown();
      runtime.store.close();
      const bytes = ["inertia.sqlite", "inertia.sqlite-wal"].map((name) => {
        try {
          return readFileSync(join(runtime.directory, name)).toString("latin1");
        } catch {
          return "";
        }
      }).join("");
      expect(bytes).not.toContain(SECRET);
    } finally {
      service.shutdown();
      try {
        runtime.store.close();
      } catch {
      }
    }
  });
});
