// @inertia-test-suite portable
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import {
  CLAUDE_PROTOCOL_SESSION_ID as original,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

const replacement = "58585858-5858-4858-8858-585858585858";
const foreign = "69696969-6969-4969-8969-696969696969";
const reset = (fields: Record<string, unknown> = {}): SDKMessage => ({
  type: "conversation_reset", uuid: "99999999-9999-4999-8999-999999999999", session_id: original,
  new_conversation_id: "78787878-7878-4878-8878-787878787878", ...fields,
}) as SDKMessage;
const result = (sessionId = replacement): SDKMessage => ({
  ...claudeSuccessResult("New conversation", "completed"), session_id: sessionId,
});

function run(messages: SDKMessage[], input: Partial<ProviderRunInput> = {}) {
  const sessions: string[] = [];
  const resumed: Array<string | undefined> = [];
  const harness = createClaudeAgentSdkHarness({
    createQuery: ({ options }) => {
      resumed.push(options?.resume);
      return fixtureClaudeQuery((async function* () { yield* messages; })());
    },
  });
  const start = (overrides: Partial<ProviderRunInput> = {}) => harness.start({
    input: {
      ...nativeProviderRunInput({
        providerId: "claude", conversationId: "session-reset", cwd: process.cwd(),
        prompt: "/clear", access: "supervised", interactionMode: "build", sessionId: original,
      }),
      ...input, ...overrides,
    },
    executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    callbacks: { onEvent: (event) => {
      if (event.type === "session") sessions.push(event.sessionId);
    } },
  });
  return { start, sessions, resumed };
}

describe("Claude authorized session reset", () => {
  it("adopts the confirmed replacement and resumes that session on the next turn", async () => {
    const messages = [claudeSystem("init"), reset(), result()];
    const fixture = run(messages);
    const first = await fixture.start().result;
    expect(first).toMatchObject({ status: "completed", sessionId: replacement, text: "New conversation" });
    expect(fixture.sessions).toEqual([replacement]);
    messages.splice(0, messages.length,
      claudeSystem("init", { session_id: replacement }), result());
    await expect(fixture.start({ sessionId: first.sessionId }).result)
      .resolves.toMatchObject({ status: "completed", sessionId: replacement });
    expect(fixture.resumed).toEqual([original, replacement]);
  });

  it.each([
    ["foreign owner", { session_id: foreign }],
    ["missing owner", { session_id: undefined }],
    ["child owner", { parent_tool_use_id: "child-tool" }],
    ["invalid replacement", { new_conversation_id: "unsafe\nidentity" }],
    ["missing replacement", { new_conversation_id: undefined }],
  ])("rejects a reset with %s", async (_label, fields) => {
    const fixture = run([claudeSystem("init"), reset(fields), result()]);
    await expect(fixture.start().result).resolves.toMatchObject({
      status: "failed", sessionId: original,
      error: "Claude returned an invalid provider session reset.",
    });
    expect(fixture.sessions).toEqual([]);
  });

  it("rejects a post-reset result from the outgoing session", async () => {
    const fixture = run([claudeSystem("init"), reset(), result(original)]);
    await expect(fixture.start().result).resolves.toMatchObject({
      status: "failed", sessionId: original,
      error: "Claude did not attest the requested provider session.",
    });
    expect(fixture.sessions).toEqual([]);
  });

  it("rejects inconsistent root identities after an authorized reset", async () => {
    const fixture = run([
      claudeSystem("init"), reset(),
      claudeSystem("status", { session_id: replacement, status: null }), result(foreign),
    ]);
    await expect(fixture.start().result).resolves.toMatchObject({
      status: "failed", sessionId: original,
      error: "Claude did not attest the requested provider session.",
    });
    expect(fixture.sessions).toEqual([]);
  });

  it("does not publish an unconfirmed replacement when the stream closes", async () => {
    const fixture = run([claudeSystem("init"), reset()]);
    await expect(fixture.start().result).resolves.toMatchObject({
      status: "failed", sessionId: original,
      error: "Claude did not confirm the replacement provider session.",
    });
    expect(fixture.sessions).toEqual([]);
  });

  it("does not let compaction reset the exact session being compacted", async () => {
    const fixture = run([claudeSystem("init"), reset(), result()], {
      operation: { kind: "compact" },
    });
    await expect(fixture.start().result).resolves.toMatchObject({
      status: "failed", sessionId: original,
      error: "Claude returned an invalid provider session reset.",
    });
  });

  it.each(["on", "off", undefined])("requires new-session Fast mode attestation (%s)", async (state) => {
    const fixture = run([
      claudeSystem("init", { fast_mode_state: "on" }), reset(),
      ...(state ? [claudeSystem("init", { session_id: replacement, fast_mode_state: state })] : []),
      result(),
    ], { supportedFastMode: "fast" });
    const input = nativeProviderRunInput({
      providerId: "claude", conversationId: "fast-reset", cwd: process.cwd(),
      prompt: "/clear", access: "supervised", interactionMode: "build",
    });
    const outcome = await fixture.start({
      modelSelection: { ...input.modelSelection, providerOptions: { fastMode: "fast" } },
    }).result;
    expect(outcome.status).toBe(state === "on" ? "completed" : "failed");
  });
});
