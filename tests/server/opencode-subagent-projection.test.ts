import type { Event } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import type { AgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { OpenCodeSessionOwnership } from "../../src/server/provider/opencode-session-ownership";
import { OpenCodeSubagentProjection } from "../../src/server/provider/opencode-subagent-projection";

type SubagentUpdate = Parameters<AgentHarnessEmitter["subagent"]>[0];

const ROOT = "root-session";
const CHILD = "child-session";
const GRANDCHILD = "grandchild-session";

function event(value: unknown): Event {
  return value as Event;
}

function created(id: string, parentID: string, title = `Task ${id}`): Event {
  return event({
    type: "session.created",
    properties: { sessionID: id, info: { id, parentID, title } },
  });
}

function assistant(
  sessionID: string,
  id: string,
  tokens?: unknown,
  model: { providerID: string; modelID: string } = { providerID: "fake", modelID: "model-b" },
): Event {
  return event({
    type: "message.updated",
    properties: {
      sessionID,
      info: { id, sessionID, role: "assistant", parentID: `${id}-prompt`, ...model, ...(tokens === undefined ? {} : { tokens }) },
    },
  });
}

function part(sessionID: string, value: Record<string, unknown>): Event {
  return event({
    type: "message.part.updated",
    properties: { sessionID, part: { sessionID, ...value } },
  });
}

function toolPart(
  sessionID: string,
  id: string,
  status: string,
  title: string,
  extra: Record<string, unknown> = {},
): Event {
  return part(sessionID, {
    id,
    messageID: `${sessionID}-assistant`,
    type: "tool",
    callID: `${id}-call`,
    tool: extra.tool ?? "read",
    state: { status, input: extra.input ?? { path: "README.md" }, title, ...(extra.metadata ? { metadata: extra.metadata } : {}) },
  });
}

function idle(sessionID: string): Event {
  return event({ type: "session.idle", properties: { sessionID } });
}

function harness(options: {
  limits?: Record<string, number>;
  redact?: <T>(value: T) => T;
} = {}) {
  const updates: SubagentUpdate[] = [];
  const ownership = new OpenCodeSessionOwnership(ROOT, 100_000);
  const projection = new OpenCodeSubagentProjection({
    rootSessionId: ROOT,
    emit: (update) => updates.push(update),
    contextLimit: (providerId, modelId) =>
      options.limits?.[`${providerId}/${modelId}`] ?? null,
    redact: options.redact ?? ((value) => value),
  });
  const observe = (...events: Event[]): void => {
    for (const value of events) {
      const { scope, active } = ownership.observe(value);
      if (scope !== "unrelated") projection.observe(value, scope, active);
    }
  };
  const latest = (sessionId: string): SubagentUpdate | undefined =>
    updates.filter(({ providerAgentId }) => providerAgentId === sessionId).at(-1);
  return { updates, projection, observe, latest };
}

describe("OpenCode delegated-agent projection", () => {
  it("projects a child and a grandchild with parent links, telemetry and final results", () => {
    const { updates, projection, observe, latest } = harness({
      limits: { "fake/model-b": 100_000, "fake/model-c": 50_000 },
    });

    observe(
      created(CHILD, ROOT, "Inspect parser (@explore subagent)"),
      part(ROOT, {
        id: "root-task",
        messageID: "root-assistant",
        type: "tool",
        callID: "root-task-call",
        tool: "task",
        state: {
          status: "running",
          input: { description: "Inspect parser", prompt: "Read the parser and report", subagent_type: "explore" },
          title: "Inspect parser",
          metadata: { sessionId: CHILD },
        },
      }),
    );
    expect(updates[0]).toEqual({
      sequence: 1,
      providerTaskId: null,
      providerAgentId: CHILD,
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: "Inspect parser (@explore subagent)",
      status: "spawned",
      isLive: true,
      description: null,
      progress: null,
      result: null,
    });
    expect(latest(CHILD)).toMatchObject({
      status: "spawned",
      description: "Read the parser and report",
    });

    observe(
      assistant(CHILD, "child-assistant-1", { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }),
      toolPart(CHILD, "child-read", "running", "Read src/parser.ts"),
      toolPart(CHILD, "child-read", "completed", "Read src/parser.ts"),
      created(GRANDCHILD, CHILD, "Check grammar (@general subagent)"),
      toolPart(CHILD, "child-task", "running", "Check grammar", {
        tool: "task",
        input: { description: "Check grammar", prompt: "Validate the grammar file" },
        metadata: { sessionId: GRANDCHILD },
      }),
      assistant(GRANDCHILD, "grandchild-assistant", { total: 40, input: 20, output: 10, reasoning: 0, cache: { read: 10, write: 0 } }, { providerID: "fake", modelID: "model-c" }),
      toolPart(GRANDCHILD, "grandchild-grep", "pending", "Search grammar"),
      part(GRANDCHILD, { id: "grandchild-text", messageID: "grandchild-assistant", type: "text", text: "Grammar is valid." }),
      idle(GRANDCHILD),
      toolPart(CHILD, "child-task", "completed", "Check grammar", {
        tool: "task",
        input: { description: "Check grammar", prompt: "Validate the grammar file" },
        metadata: { sessionId: GRANDCHILD },
      }),
      assistant(CHILD, "child-assistant-2", { input: 30, output: 7, reasoning: 1, cache: { read: 4, write: 0 } }),
      part(CHILD, { id: "child-text", messageID: "child-assistant-2", type: "text", text: "Parser reviewed; grammar is valid." }),
      event({ type: "session.status", properties: { sessionID: CHILD, status: { type: "idle" } } }),
    );
    expect(latest(CHILD)).toMatchObject({ status: "waiting", providerStatus: "idle", isLive: true, result: null });
    projection.finish(true);

    expect(latest(GRANDCHILD)).toMatchObject({
      parentProviderAgentId: CHILD,
      providerName: "Check grammar (@general subagent)",
      description: "Validate the grammar file",
      status: "completed",
      isLive: false,
      result: "Grammar is valid.",
      model: "fake/model-c",
      usage: {
        totalTokens: 40,
        inputTokens: 20,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
        contextTokens: 30,
        maxContextTokens: 50_000,
      },
      toolUseCount: 1,
    });
    expect(latest(GRANDCHILD)).not.toHaveProperty("activity");
    expect(updates.some(({ providerAgentId, activity }) =>
      providerAgentId === GRANDCHILD && activity === "Search grammar")).toBe(true);

    expect(latest(CHILD)).toMatchObject({
      parentProviderAgentId: null,
      status: "completed",
      isLive: false,
      result: "Parser reviewed; grammar is valid.",
      model: "fake/model-b",
      usage: {
        totalTokens: 21 + 42,
        inputTokens: 30,
        cachedInputTokens: 4,
        cacheWriteInputTokens: 0,
        outputTokens: 7,
        reasoningOutputTokens: 1,
        contextTokens: 34,
        maxContextTokens: 100_000,
      },
      toolUseCount: 2,
    });
    expect(updates.some(({ providerAgentId, activity }) =>
      providerAgentId === CHILD && activity === "Read src/parser.ts")).toBe(true);
    expect(updates.find(({ providerAgentId, status }) =>
      providerAgentId === CHILD && status === "running")).toBeDefined();
    expect(updates.map(({ sequence }) => sequence))
      .toEqual(updates.map((_update, index) => index + 1));
  });

  it.each([false, true])("retains every latest-assistant text part without duplicating snapshots (late older part: %s)", (lateOlderPart) => {
    const { projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      assistant(CHILD, "earlier-assistant"),
      part(CHILD, { id: "earlier-text", messageID: "earlier-assistant", type: "text", text: "Earlier progress." }),
      assistant(CHILD, "final-assistant"),
      part(CHILD, { id: "final-text-1", messageID: "final-assistant", type: "text", text: "First finding" }),
      part(CHILD, { id: "final-text-2", messageID: "final-assistant", type: "text", text: "Second finding." }),
      part(CHILD, { id: "final-text-1", messageID: "final-assistant", type: "text", text: "First finding.\n\n" }),
    );
    if (lateOlderPart) {
      observe(part(CHILD, { id: "earlier-text", messageID: "earlier-assistant", type: "text", text: "Late earlier progress." }));
    }
    observe(idle(CHILD));
    projection.finish(true);

    expect(latest(CHILD)).toMatchObject({
      status: "completed",
      result: "First finding.\n\nSecond finding.",
    });
  });

  it("does not reuse an earlier assistant result when the latest assistant has no text", () => {
    const { projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      assistant(CHILD, "earlier-assistant"),
      part(CHILD, { id: "earlier-text", messageID: "earlier-assistant", type: "text", text: "Earlier progress." }),
      assistant(CHILD, "final-assistant"),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)).toMatchObject({ status: "completed", result: null });
  });

  it("bounds the combined result across text parts and clears replaced text", () => {
    const { projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      assistant(CHILD, "final-assistant"),
      part(CHILD, { id: "removed-text", messageID: "final-assistant", type: "text", text: "Removed text." }),
      part(CHILD, { id: "removed-text", messageID: "final-assistant", type: "text", text: "" }),
      part(CHILD, { id: "first-text", messageID: "final-assistant", type: "text", text: "a".repeat(10_000) }),
      part(CHILD, { id: "second-text", messageID: "final-assistant", type: "text", text: "b".repeat(10_000) }),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)?.result).toBe("a".repeat(10_000) + "b".repeat(6_000));
  });

  it("bounds retained result parts while accepting later snapshots for retained parts", () => {
    const { projection, observe, latest } = harness();
    observe(created(CHILD, ROOT), assistant(CHILD, "final-assistant"));
    for (let index = 0; index < 130; index += 1) {
      observe(part(CHILD, { id: `text-${index}`, messageID: "final-assistant", type: "text", text: "a" }));
    }
    observe(
      part(CHILD, { id: "text-0", messageID: "final-assistant", type: "text", text: "Updated " }),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)?.result).toBe(`Updated ${"a".repeat(127)}`);
  });

  it("retains later-part text when a full-length earlier snapshot is corrected", () => {
    const { projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      assistant(CHILD, "final-assistant"),
      part(CHILD, { id: "first-text", messageID: "final-assistant", type: "text", text: "a".repeat(16_000) }),
      part(CHILD, { id: "second-text", messageID: "final-assistant", type: "text", text: "Second finding." }),
      part(CHILD, { id: "first-text", messageID: "final-assistant", type: "text", text: "Corrected first finding.\n\n" }),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)?.result).toBe("Corrected first finding.\n\nSecond finding.");
  });

  it("retains the latest result when an older message updates beyond the usage accounting cap", () => {
    const { projection, observe, latest } = harness();
    observe(created(CHILD, ROOT));
    for (let index = 0; index < 2_048; index += 1) {
      observe(assistant(CHILD, `assistant-${index}`));
    }
    observe(
      assistant(CHILD, "overflow-old"),
      assistant(CHILD, "overflow-new"),
      part(CHILD, { id: "final-text", messageID: "overflow-new", type: "text", text: "Latest answer." }),
      assistant(CHILD, "overflow-old", { input: 10, output: 1 }),
      part(CHILD, { id: "older-text", messageID: "overflow-old", type: "text", text: "Stale answer." }),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)?.result).toBe("Latest answer.");
  });

  it("uses provider creation times to reject stale messages beyond retained identity history", () => {
    const { projection, observe, latest } = harness();
    const datedAssistant = (index: number, completed?: number): Event => event({
      type: "message.updated",
      properties: { sessionID: CHILD, info: { id: `assistant-${index}`, sessionID: CHILD, role: "assistant", time: { created: index, ...(completed === undefined ? {} : { completed }) } } },
    });
    observe(created(CHILD, ROOT));
    for (let index = 0; index < 2_300; index += 1) observe(datedAssistant(index));
    observe(
      part(CHILD, { id: "final-text", messageID: "assistant-2299", type: "text", text: "Latest answer." }),
      datedAssistant(2_048, 2_400),
      part(CHILD, { id: "older-text", messageID: "assistant-2048", type: "text", text: "Stale answer." }),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)?.result).toBe("Latest answer.");
  });

  it("reports a child session error as a failed task with bounded error text", () => {
    const { observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      assistant(CHILD, "child-assistant"),
      event({
        type: "session.error",
        properties: {
          sessionID: CHILD,
          error: { name: "APIError", data: { message: `Upstream failed ${"x".repeat(20_000)}` } },
        },
      }),
      idle(CHILD),
    );

    const failed = latest(CHILD)!;
    expect(failed).toMatchObject({ status: "failed", isLive: false });
    expect(failed.result).toMatch(/^Upstream failed x+$/u);
    expect(failed.result).toHaveLength(16_000);
  });

  it("reports an aborted child as cancelled and a deleted live child as lost", () => {
    const { updates, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      created(GRANDCHILD, ROOT),
      assistant(CHILD, "child-assistant"),
      event({
        type: "session.error",
        properties: { sessionID: CHILD, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      }),
      event({ type: "session.deleted", properties: { info: { id: GRANDCHILD, parentID: ROOT } } }),
    );
    const settled = updates.length;
    observe(
      assistant(GRANDCHILD, "late-assistant", { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }),
      idle(CHILD),
    );

    expect(latest(CHILD)).toMatchObject({ status: "cancelled", isLive: false, result: "Aborted" });
    expect(latest(GRANDCHILD)).toMatchObject({ status: "lost", isLive: false });
    expect(updates).toHaveLength(settled);
  });

  it("cancels live and waiting children once and emits nothing after settlement", () => {
    const { updates, projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      created(GRANDCHILD, CHILD),
      assistant(GRANDCHILD, "grandchild-assistant"),
      idle(GRANDCHILD),
    );
    projection.cancelLive();
    projection.cancelLive();
    const settled = updates.length;
    observe(
      assistant(CHILD, "child-assistant", { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }),
      created("late-session", ROOT),
      idle(CHILD),
    );

    expect(latest(CHILD)).toMatchObject({ status: "cancelled", isLive: false });
    expect(latest(GRANDCHILD)).toMatchObject({ status: "cancelled", isLive: false });
    expect(updates.filter(({ status }) => status === "cancelled")).toHaveLength(2);
    expect(updates).toHaveLength(settled);
  });

  it("emits nothing once sealed", () => {
    const { updates, projection, observe } = harness();
    observe(created(CHILD, ROOT));
    projection.finish(false);
    observe(assistant(CHILD, "child-assistant"), idle(CHILD));
    projection.cancelLive();
    projection.finish(true);

    expect(updates.map(({ status }) => status)).toEqual(["spawned"]);
  });

  it("ignores malformed child messages and parts without failing", () => {
    const { updates, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      event({ type: "message.updated", properties: { sessionID: CHILD } }),
      event({ type: "message.updated", properties: { sessionID: CHILD, info: { id: "bad", sessionID: CHILD, role: "assistant", tokens: "many", providerID: 7, modelID: null } } }),
      event({ type: "message.updated", properties: { sessionID: CHILD, info: { id: "user", sessionID: CHILD, role: "user" } } }),
      part(CHILD, { id: "prompt-text", messageID: "user", type: "text", text: "Delegated prompt must not become the result" }),
      part(CHILD, { id: "orphan-text", messageID: "unknown-message", type: "text", text: "Unattributed text" }),
      part(CHILD, { id: "bad-tool", messageID: "bad", type: "tool", state: "running" }),
      part(CHILD, { messageID: "bad", type: "tool", state: { status: "running", title: "No identity" } }),
      part(CHILD, { id: "bad-text", messageID: "bad", type: "text", text: 42 }),
      event({ type: "session.error", properties: { sessionID: CHILD, error: "not an object" } }),
    );

    const failed = latest(CHILD)!;
    expect(failed).toMatchObject({ status: "failed", isLive: false, result: "OpenCode reported an error for this delegated task." });
    expect(failed).not.toHaveProperty("usage");
    expect(failed).not.toHaveProperty("model");
    expect(failed.toolUseCount).toBe(1);
    expect(updates.every(({ result }) => result === null || !result.includes("Delegated prompt"))).toBe(true);
  });

  it("attributes task input only to a child of the session that ran the task", () => {
    const { updates, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      created(GRANDCHILD, CHILD),
      toolPart(ROOT, "root-task", "running", "Wrong parent", {
        tool: "task",
        input: { prompt: "Misattributed" },
        metadata: { sessionId: GRANDCHILD },
      }),
      toolPart(CHILD, "child-task", "running", "Right parent", {
        tool: "task",
        input: { description: "Short summary" },
        metadata: { sessionId: GRANDCHILD },
      }),
    );

    expect(latest(GRANDCHILD)).toMatchObject({ description: "Short summary" });
    expect(updates.some(({ description }) => description === "Misattributed")).toBe(false);
  });

  it("bounds titles, activity labels and result text before they leave the adapter", () => {
    const { projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT, `Title ${"t".repeat(400)}`),
      assistant(CHILD, "child-assistant"),
      toolPart(CHILD, "child-tool", "running", `Label ${"l".repeat(400)}`),
    );
    expect(latest(CHILD)?.providerName).toHaveLength(200);
    expect(latest(CHILD)?.activity).toHaveLength(200);

    observe(
      part(CHILD, { id: "child-text", messageID: "child-assistant", type: "text", text: `Result ${"r".repeat(40_000)}` }),
      idle(CHILD),
    );
    projection.finish(true);
    expect(latest(CHILD)?.result).toHaveLength(16_000);
  });

  it("projects content only after redaction", () => {
    const { projection, observe, latest } = harness({
      redact: <T>(value: T): T => JSON.parse(
        JSON.stringify(value).replaceAll("bridge-secret", "[redacted]"),
      ) as T,
    });
    observe(
      created(CHILD, ROOT, "Use bridge-secret"),
      assistant(CHILD, "child-assistant"),
      part(CHILD, { id: "child-text", messageID: "child-assistant", type: "text", text: "Saw bridge-secret" }),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)).toMatchObject({
      providerName: "Use [redacted]",
      result: "Saw [redacted]",
    });
  });

  it("stops projecting new children at the per-turn trace cap without failing the run", () => {
    const { updates, observe } = harness();
    for (let index = 0; index < 130; index += 1) {
      observe(created(`child-${index}`, ROOT));
    }

    const projected = new Set(updates.map(({ providerAgentId }) => providerAgentId));
    expect(projected.size).toBe(128);
    expect(projected.has("child-128")).toBe(false);
  });

  it("stops counting tool parts beyond a child's budget without failing the run", () => {
    const { projection, observe, latest } = harness();
    observe(created(CHILD, ROOT), assistant(CHILD, "child-assistant"));
    for (let index = 0; index < 4_096; index += 1) {
      observe(toolPart(CHILD, `tool-${index}`, "completed", "Read"));
    }
    expect(latest(CHILD)?.toolUseCount).toBe(4_096);

    expect(() => observe(toolPart(CHILD, "tool-overflow", "running", "Read more")))
      .not.toThrow();
    expect(latest(CHILD)).not.toHaveProperty("toolUseCount");
    expect(latest(CHILD)?.activity).toBe("Read more");
    observe(idle(CHILD));
    projection.finish(true);
    expect(latest(CHILD)).toMatchObject({ status: "completed", isLive: false });
  });

  it("stops reporting a child's usage total beyond its message budget without failing the run", () => {
    const { projection, observe, latest } = harness({ limits: { "fake/model-b": 100_000 } });
    observe(created(CHILD, ROOT));
    for (let index = 0; index < 2_048; index += 1) {
      observe(assistant(CHILD, `assistant-${index}`, { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }));
    }
    expect(latest(CHILD)?.usage?.totalTokens).toBe(2_048 * 11);

    expect(() => observe(assistant(CHILD, "assistant-overflow", { input: 20, output: 2, reasoning: 0, cache: { read: 5, write: 0 } })))
      .not.toThrow();
    expect(latest(CHILD)?.usage).toEqual({
      totalTokens: null,
      inputTokens: 20,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 0,
      contextTokens: 25,
      maxContextTokens: 100_000,
    });
    observe(
      assistant(CHILD, "assistant-0", { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }),
      part(CHILD, { id: "late-text", messageID: "assistant-overflow", type: "text", text: "Finished after many steps." }),
      idle(CHILD),
    );
    expect(latest(CHILD)?.usage?.totalTokens).toBeNull();
    projection.finish(true);
    expect(latest(CHILD)).toMatchObject({
      status: "completed",
      result: "Finished after many steps.",
    });
  });

  it("keeps exact totals for many concurrent children within their own budgets", () => {
    const { projection, observe, latest } = harness();
    for (let child = 0; child < 9; child += 1) observe(created(`child-${child}`, ROOT));
    for (let step = 0; step < 230; step += 1) {
      for (let child = 0; child < 9; child += 1) {
        observe(assistant(`child-${child}`, `child-${child}-${step}`, { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }));
      }
    }
    for (let child = 0; child < 9; child += 1) observe(idle(`child-${child}`));
    projection.finish(true);

    for (let child = 0; child < 9; child += 1) {
      expect(latest(`child-${child}`)).toMatchObject({
        status: "completed",
        usage: { totalTokens: 460 },
      });
    }
  });

  it("treats idle as waiting and resumes the same trace when the child works again", () => {
    const { updates, projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      idle(CHILD),
    );
    expect(latest(CHILD)).toMatchObject({ status: "waiting", providerStatus: "idle", isLive: true });

    observe(
      event({ type: "session.status", properties: { sessionID: CHILD, status: { type: "busy" } } }),
      assistant(CHILD, "first", { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }),
      idle(CHILD),
      event({ id: "resumed-busy", type: "session.status", properties: { sessionID: CHILD, status: { type: "busy" } } }),
    );
    expect(latest(CHILD)).toMatchObject({ status: "running", providerStatus: "busy", isLive: true });
    observe(
      assistant(CHILD, "second", { input: 400, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }),
      toolPart(CHILD, "second-tool", "running", "Edit src/app.ts"),
    );
    expect(latest(CHILD)).toMatchObject({
      status: "running",
      activity: "Edit src/app.ts",
      usage: { totalTokens: 451 },
    });

    projection.finish(true);
    expect(latest(CHILD)).toMatchObject({ status: "running", isLive: true });
    expect(updates.some(({ status }) => status === "completed")).toBe(false);
  });

  it("completes a resumed child at normal run finish with its later usage", () => {
    const { projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      idle(CHILD),
      event({ type: "session.status", properties: { sessionID: CHILD, status: { type: "busy" } } }),
      assistant(CHILD, "after-idle", { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistant(CHILD, "after-idle", { input: 9, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }),
      part(CHILD, { id: "after-idle-text", messageID: "after-idle", type: "text", text: "Resumed answer." }),
      idle(CHILD),
    );
    projection.finish(true);

    expect(latest(CHILD)).toMatchObject({
      status: "completed",
      isLive: false,
      result: "Resumed answer.",
      usage: { totalTokens: 13 },
    });
  });

  it("fails a waiting child that later reports a session error", () => {
    const { observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      idle(CHILD),
      event({ type: "session.error", properties: { sessionID: CHILD, error: { name: "UnknownError", data: { message: "Late failure" } } } }),
    );
    expect(latest(CHILD)).toMatchObject({ status: "failed", isLive: false, result: "Late failure" });
  });

  it("completes or fails a child when the parent's task tool part settles", () => {
    const { updates, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      created(GRANDCHILD, ROOT),
      assistant(CHILD, "child-assistant"),
      part(CHILD, { id: "child-text", messageID: "child-assistant", type: "text", text: "Child answer." }),
      toolPart(ROOT, "root-task", "completed", "Inspect", {
        tool: "task",
        input: { prompt: "Inspect" },
        metadata: { sessionId: CHILD },
      }),
      part(ROOT, {
        id: "root-task-2",
        messageID: "root-assistant",
        type: "tool",
        callID: "root-task-2-call",
        tool: "task",
        state: { status: "error", input: { prompt: "Review" }, error: "Delegated review failed.", metadata: { sessionId: GRANDCHILD } },
      }),
    );
    const settled = updates.length;
    observe(assistant(CHILD, "late", { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }));

    expect(latest(CHILD)).toMatchObject({ status: "completed", isLive: false, result: "Child answer." });
    expect(latest(GRANDCHILD)).toMatchObject({ status: "failed", isLive: false, result: "Delegated review failed." });
    expect(updates).toHaveLength(settled);
  });

  it("completes only waiting children when the run finishes normally", () => {
    const { projection, observe, latest } = harness();
    observe(
      created(CHILD, ROOT),
      created(GRANDCHILD, ROOT),
      created("busy-session", ROOT),
      created("spawned-session", ROOT),
      assistant(CHILD, "child-assistant"),
      idle(CHILD),
      idle(GRANDCHILD),
      event({ type: "session.status", properties: { sessionID: "busy-session", status: { type: "busy" } } }),
    );
    projection.finish(true);

    expect(latest(CHILD)).toMatchObject({ status: "completed", isLive: false });
    expect(latest(GRANDCHILD)).toMatchObject({ status: "completed", isLive: false });
    expect(latest("busy-session")).toMatchObject({ status: "running", isLive: true });
    expect(latest("spawned-session")).toMatchObject({ status: "spawned", isLive: true });
  });

  it("leaves waiting children live when the run does not finish normally", () => {
    const { updates, projection, observe } = harness();
    observe(created(CHILD, ROOT), idle(CHILD));
    projection.finish(false);

    expect(updates.map(({ status }) => status)).toEqual(["spawned", "waiting"]);
  });
});
