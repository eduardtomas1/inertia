// @inertia-test-suite portable
import { afterEach, describe, expect, it } from "vitest";

import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { createProviderEmitter, providerCallbacksFromHarness } from "../../src/server/provider/emitter";
import { PiEvents, segmentClosingEmitter } from "../../src/server/provider/pi-events";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

const update = (event: Record<string, unknown>) => ({ type: "message_update", assistantMessageEvent: { contentIndex: 0, ...event } });
const start = { type: "message_start", message: { role: "assistant" } };
const end = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } };

/**
 * Pi protocol events through the harness's Pi projection, live into a turn controller. Inertia does not steer Pi
 * (follow-ups queue), so the follow-up cases run on OpenCode, a steerable harness that also joins its messages with
 * a blank line: they prove how the runtime places a follow-up around a replaced segment, whoever replaces it.
 */
async function piTurn(providerId: "pi" | "opencode" = "pi") {
  const runtime = await createTurnControllerTestRuntime({}, {
    modelSelection: providerNativeModelSelection({ providerId, modelId: "provider-default" }) });
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Review the parser." });
  runtime.controller.start(queued.turn.id);
  const identity = turnControllerTestIdentity(runtime);
  const callbacks = providerCallbacksFromHarness(createProviderEmitter(providerId, identity.conversationId,
    { onEvent: (event) => runtime.provider.emit(event) }, identity.runId, identity.turnId));
  const emit = segmentClosingEmitter(createAgentHarnessEmitter(providerId, identity.conversationId, callbacks, identity.runId,
    identity.turnId), () => pi.closeSegment());
  const pi = new PiEvents(emit, {});
  runtime.provider.emit({ ...identity, type: "status", status: "running" });
  const flush = () => {
    for (const [id, callback] of runtime.scheduler.callbacks) {
      if ((runtime.scheduler.delays.get(id) ?? Infinity) < 1_000) { runtime.scheduler.clearTimeout(id); callback(); }
    }
  };
  const receive = (...events: Record<string, unknown>[]) => { for (const event of events) pi.receive(event); flush(); };
  const tool = (id: string) => receive({ type: "tool_execution_start", toolCallId: id, toolName: "read" },
    { type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [] } });
  const steer = async (content: string) => {
    const admission = runtime.controller.acquireFollowUpAdmission(runtime.conversationId)!;
    const followUp = await runtime.controller.steer(admission, { content, imagePaths: [] });
    admission.release();
    expect(followUp).toMatchObject({ kind: "accepted" });
    return runtime.store.snapshot().messages.find((message) => message.role === "user" && message.content === content)!;
  };
  const finish = async (resultText?: string) => {
    pi.finish();
    runtime.provider.resolve({ status: "completed", text: resultText ?? pi.text.toString() });
    await flushTurnControllerTestPromises();
    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(turn.status).toBe("completed");
    const assistant = runtime.store.snapshot().messages.filter((message) => message.turnId === turn.id && message.role === "assistant");
    runtime.store.close();
    return { turn, assistant, text: pi.text.toString() };
  };
  return { emit, receive, tool, steer, finish };
}

const createdBefore = (left: { createdAt: string }, right: { createdAt: string }) => Date.parse(left.createdAt) <= Date.parse(right.createdAt);

describe("replaced segments and follow-ups through the turn controller", () => {
  it("keeps the message a follow-up was placed after when a restart empties it and Pi streams again", async () => {
    const pi = await piTurn("opencode");
    pi.receive(start, update({ type: "text_delta", delta: "Intro." }), end);
    pi.tool("t-1");
    pi.receive(start, update({ type: "text_delta", delta: "Hello" }));
    const followUp = await pi.steer("Also check the tests.");
    pi.receive(update({ type: "text_start" }), update({ type: "text_delta", delta: "Hi there" }), end);
    const { turn, assistant } = await pi.finish();
    expect(assistant.map(({ content }) => content)).toEqual(["Intro.", "Hi there"]);
    // Still the message the follow-up came after: nothing answers the follow-up yet.
    expect(createdBefore(assistant[1]!, followUp)).toBe(true);
    expect(turn.terminalAssistantMessageId).toBeNull();
  });

  it("does not report earlier commentary as the answer when a restart empties the message a follow-up came after", async () => {
    const pi = await piTurn("opencode");
    pi.receive(start, update({ type: "text_delta", delta: "Intro." }), end);
    pi.tool("t-1");
    pi.receive(start, update({ type: "text_delta", delta: "Hello" }));
    await pi.steer("Also check the tests.");
    pi.receive(update({ type: "text_start" }), update({ type: "text_end" }), end);
    const { turn, assistant } = await pi.finish();
    expect(assistant.map(({ content }) => content)).toEqual(["Intro."]);
    expect(turn.terminalAssistantMessageId).toBeNull();
  });

  it("does not report earlier commentary as the answer when the final result empties the message a follow-up came after", async () => {
    const pi = await piTurn("opencode");
    pi.receive(start, update({ type: "text_delta", delta: "Intro." }), end);
    pi.tool("t-1");
    pi.receive(start, update({ type: "text_delta", delta: "Hello" }));
    await pi.steer("Also check the tests.");
    pi.receive(end);
    // The harness's final text no longer holds the open message.
    const { turn, assistant } = await pi.finish("Intro.");
    expect(assistant.map(({ content }) => content)).toEqual(["Intro."]);
    expect(turn.terminalAssistantMessageId).toBeNull();
  });

  it("answers a follow-up in its own message after it once Pi starts a new message", async () => {
    const pi = await piTurn("opencode");
    pi.receive(start, update({ type: "text_delta", delta: "Hello" }));
    const followUp = await pi.steer("Also check the tests.");
    pi.receive(update({ type: "text_start" }), end, start, update({ type: "text_delta", delta: "Tests pass." }), end);
    const { turn, assistant } = await pi.finish();
    expect(assistant.map(({ content }) => content)).toEqual(["Tests pass."]);
    expect(createdBefore(followUp, assistant[0]!)).toBe(true);
    expect(turn.terminalAssistantMessageId).toBe(assistant[0]!.id);
  });

  it("keeps each message its own text after a follow-up, with the run's text joined by blank lines", async () => {
    const pi = await piTurn("opencode");
    pi.receive(start, update({ type: "text_delta", delta: "Working on it." }));
    await pi.steer("Also check the tests.");
    pi.receive(end, start, update({ type: "text_delta", delta: "Done." }), end);
    const { turn, assistant } = await pi.finish();
    expect(assistant.map(({ content }) => content)).toEqual(["Working on it.", "Done."]);
    expect(turn.terminalAssistantMessageId).toBe(assistant[1]!.id);
  });

  it("puts a restarted block that corrects text before a mid-message activity whole after it, never spliced", async () => {
    const pi = await piTurn();
    pi.receive(start, update({ type: "text_delta", delta: "The wrld is " }));
    pi.emit.activity("tool", "completed", "Pi extension", { detail: "Indexing" });
    pi.receive(update({ type: "text_start" }), update({ type: "text_delta", delta: "The world is round." }), end);
    const { assistant } = await pi.finish();
    expect(assistant.map(({ content }) => content)).toEqual(["The wrld is ", "The world is round."]);
  });

  it("keeps the two attempts apart in the run's final text, and the end-of-run reconcile leaves every message as shown", async () => {
    const pi = await piTurn();
    pi.receive(start, update({ type: "text_delta", delta: "First." }), end);
    pi.tool("t-1");
    pi.receive(start, update({ type: "text_delta", delta: "The answer is 41" }));
    pi.emit.activity("tool", "completed", "Pi extension", { detail: "Checking" });
    pi.receive(update({ type: "text_start" }), update({ type: "text_delta", delta: "The answer is 42." }), end);
    const { assistant, text } = await pi.finish();
    expect(text).toBe("First.\n\nThe answer is 41\n\nThe answer is 42.");
    expect(assistant.map(({ content }) => content)).toEqual(["First.", "The answer is 41", "The answer is 42."]);
  });
});
