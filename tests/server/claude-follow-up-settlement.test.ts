// @inertia-test-suite portable
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe("Claude accepted follow-up settlement", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it.each((["refused", "cancelled", "discarded"] as const).flatMap((state) =>
    (["initial", "follow-up"] as const).map((owner) => ({ state, owner }))))(
    "settles when the $owner prompt is $state with an accepted follow-up without requiring EOF",
    async ({ state, owner }) => {
      const root = portableFixtureRoot("Claude follow-up terminal lifecycle");
      roots.push(root);
      let ready!: () => void;
      const initialConsumed = new Promise<void>((resolve) => { ready = resolve; });
      let readPastTerminal!: () => void;
      const unexpectedRead = new Promise<"read-past-terminal">((resolve) => {
        readPastTerminal = () => resolve("read-past-terminal");
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const close = vi.fn();
      const harness = createClaudeAgentSdkHarness({
        createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          const initial = (await iterator.next()).value!;
          ready();
          const followUp = (await iterator.next()).value!;
          if (owner === "follow-up") {
            yield { ...claudeSuccessResult("Initial request complete", "completed"),
              user_message_uuid: initial.uuid } as SDKMessage;
          }
          yield {
            type: "command_lifecycle", command_uuid: owner === "initial" ? initial.uuid : followUp.uuid, state,
            uuid: `follow-up-${state}`, session_id: CLAUDE_PROTOCOL_SESSION_ID,
          } as unknown as SDKMessage;
          // Persistent input streams can remain open indefinitely after refusal.
          readPastTerminal();
          await released;
        })(), { close }),
      });
      const run = harness.start({
        input: nativeProviderRunInput({ providerId: "claude", conversationId: "follow-up-terminal",
          cwd: root, prompt: "Start the request", interactionMode: "build", access: "supervised" }),
        executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
      });
      try {
        await initialConsumed;
        if (!run.extension || !("steer" in run.extension)) throw new Error("Missing follow-up control.");
        await expect(run.extension.steer?.({ content: "Handle this follow-up", imagePaths: [] }))
          .resolves.toBe(true);
        expect(await Promise.race([run.result.then(() => "settled"), unexpectedRead]))
          .toBe("settled");
        await expect(run.result).resolves.toMatchObject({
          status: "failed", cleanupConfirmed: true,
          ...(owner === "follow-up" ? {
            error: `Claude ${state} an accepted follow-up before returning an answer.`,
          } : { failure: { terminalEvent: `lifecycle/prompt-${state}` } }),
        });
        expect(close).toHaveBeenCalledOnce();
      } finally {
        run.cancel(true);
        release();
        await run.result;
      }
    },
  );

  it.each(["foreign-refusal", "child-refusal", "settled-refusal", "unknown-state", "completed-before-result", "eof"] as const)(
    "preserves accepted follow-up correlation after %s",
    async (ending) => {
      const root = portableFixtureRoot("Claude follow-up correlation control");
      roots.push(root);
      let ready!: () => void;
      const initialConsumed = new Promise<void>((resolve) => { ready = resolve; });
      const close = vi.fn();
      const harness = createClaudeAgentSdkHarness({
        createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          const initial = (await iterator.next()).value!;
          ready();
          const followUp = (await iterator.next()).value!;
          const second = ending === "settled-refusal" ? (await iterator.next()).value! : null;
          yield { ...claudeSuccessResult("Initial request complete", "completed"),
            user_message_uuid: initial.uuid } as SDKMessage;
          if (ending === "eof") return;
          if (second) {
            yield { ...claudeSuccessResult("First follow-up complete", "completed"),
              user_message_uuid: followUp.uuid } as SDKMessage;
          }
          yield {
            type: "command_lifecycle",
            command_uuid: ending === "foreign-refusal" ? "unrelated-prompt" : followUp.uuid,
            state: ending === "completed-before-result" ? "completed"
              : ending === "unknown-state" ? "future-state" : "refused",
            ...(ending === "child-refusal" ? { parent_tool_use_id: "child-task" } : {}),
            uuid: "follow-up-control", session_id: CLAUDE_PROTOCOL_SESSION_ID,
          } as unknown as SDKMessage;
          yield { ...claudeSuccessResult("Follow-up complete", "completed"),
            user_message_uuid: second?.uuid ?? followUp.uuid } as SDKMessage;
        })(), { close }),
      });
      const run = harness.start({
        input: nativeProviderRunInput({ providerId: "claude", conversationId: "follow-up-control",
          cwd: root, prompt: "Start the request", interactionMode: "build", access: "supervised" }),
        executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
      });
      await initialConsumed;
      if (!run.extension || !("steer" in run.extension)) throw new Error("Missing follow-up control.");
      await expect(run.extension.steer?.({ content: "Handle this follow-up", imagePaths: [] }))
        .resolves.toBe(true);
      if (ending === "settled-refusal") {
        await expect(run.extension.steer?.({ content: "Handle a second follow-up", imagePaths: [] }))
          .resolves.toBe(true);
      }
      await expect(run.result).resolves.toMatchObject(ending === "eof"
        ? { status: "failed", error: "Claude Agent SDK exited before correlating every accepted follow-up." }
        : { status: "completed", text: "Follow-up complete" });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("keeps local cancellation authoritative over a late follow-up refusal", async () => {
    const root = portableFixtureRoot("Claude cancelled follow-up refusal");
    roots.push(root);
    let ready!: () => void;
    const initialConsumed = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        await iterator.next();
        ready();
        const followUp = (await iterator.next()).value!;
        await released;
        yield {
          type: "command_lifecycle", command_uuid: followUp.uuid, state: "refused",
          uuid: "late-refusal", session_id: CLAUDE_PROTOCOL_SESSION_ID,
        } as unknown as SDKMessage;
      })()),
    });
    const run = harness.start({
      input: nativeProviderRunInput({ providerId: "claude", conversationId: "follow-up-cancel",
        cwd: root, prompt: "Start the request", interactionMode: "build", access: "supervised" }),
      executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
    });
    await initialConsumed;
    if (!run.extension || !("steer" in run.extension)) throw new Error("Missing follow-up control.");
    await expect(run.extension.steer?.({ content: "Handle this follow-up", imagePaths: [] }))
      .resolves.toBe(true);
    run.cancel(false);
    release();
    await expect(run.result).resolves.toMatchObject({ status: "cancelled", cleanupConfirmed: true });
  });

  it.each(["success-error", "error_max_turns"] as const)(
    "settles a %s result without waiting for pending follow-ups or EOF",
    async (kind) => {
      const root = portableFixtureRoot("Claude terminal error with follow-up");
      roots.push(root);
      let ready!: () => void;
      const initialConsumed = new Promise<void>((resolve) => { ready = resolve; });
      let readPastTerminal!: () => void;
      const unexpectedRead = new Promise<"read-past-terminal">((resolve) => {
        readPastTerminal = () => resolve("read-past-terminal");
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const close = vi.fn();
      const harness = createClaudeAgentSdkHarness({
        createQuery: ({ prompt }) => fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          const initial = (await iterator.next()).value!;
          ready();
          await iterator.next();
          yield {
            ...claudeSuccessResult("Provider could not finish"),
            is_error: true,
            user_message_uuid: initial.uuid,
            ...(kind === "success-error"
              ? { terminal_reason: "api_error" }
              : { subtype: kind, errors: ["Maximum turns exceeded"] }),
          } as SDKMessage;
          readPastTerminal();
          await released;
        })(), { close }),
      });
      const run = harness.start({
        input: nativeProviderRunInput({ providerId: "claude", conversationId: "follow-up-error",
          cwd: root, prompt: "Start the request", interactionMode: "build", access: "supervised" }),
        executable: process.execPath, environment: {}, providerNativeToolsAvailable: true,
      });
      try {
        await initialConsumed;
        if (!run.extension || !("steer" in run.extension)) throw new Error("Missing follow-up control.");
        await expect(run.extension.steer?.({ content: "Handle this follow-up", imagePaths: [] }))
          .resolves.toBe(true);
        expect(await Promise.race([run.result.then(() => "settled"), unexpectedRead]))
          .toBe("settled");
        await expect(run.result).resolves.toMatchObject({
          status: "failed", cleanupConfirmed: true,
          failure: { terminalEvent: `result/${kind === "success-error" ? "api_error" : kind}` },
        });
        expect(close).toHaveBeenCalledOnce();
      } finally {
        run.cancel(true);
        release();
        await run.result;
      }
    },
  );
});
