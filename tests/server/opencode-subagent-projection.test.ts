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
    const { updates, observe, latest } = harness({
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
      assistant(CHILD, "child-assistant-2", { input: 30, output: 7, reasoning: 1, cache: { read: 4, write: 0 } }),
      part(CHILD, { id: "child-text", messageID: "child-assistant-2", type: "text", text: "Parser reviewed; grammar is valid." }),
      event({ type: "session.status", properties: { sessionID: CHILD, status: { type: "idle" } } }),
    );

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

  it("cancels live children once and emits nothing after settlement", () => {
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
    expect(latest(GRANDCHILD)).toMatchObject({ status: "completed", isLive: false });
    expect(updates.filter(({ status }) => status === "cancelled")).toHaveLength(1);
    expect(updates).toHaveLength(settled);
  });

  it("emits nothing once sealed", () => {
    const { updates, projection, observe } = harness();
    observe(created(CHILD, ROOT));
    projection.seal();
    observe(assistant(CHILD, "child-assistant"), idle(CHILD));
    projection.cancelLive();

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
    const { observe, latest } = harness();
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
    expect(latest(CHILD)?.result).toHaveLength(16_000);
  });

  it("projects content only after redaction", () => {
    const { observe, latest } = harness({
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

  it("fails closed when live children exceed the bounded tool-part budget", () => {
    const { observe } = harness();
    observe(created(CHILD, ROOT), assistant(CHILD, "child-assistant"));
    for (let index = 0; index < 4_096; index += 1) {
      observe(toolPart(CHILD, `tool-${index}`, "completed", "Read"));
    }

    expect(() => observe(toolPart(CHILD, "tool-overflow", "running", "Read")))
      .toThrow("OpenCode exceeded the bounded delegated-agent tool budget.");
  });

  it("fails closed when live children exceed the bounded message budget", () => {
    const { observe } = harness();
    observe(created(CHILD, ROOT));
    for (let index = 0; index < 2_048; index += 1) {
      observe(assistant(CHILD, `assistant-${index}`));
    }

    expect(() => observe(assistant(CHILD, "assistant-overflow")))
      .toThrow("OpenCode exceeded the bounded delegated-agent message budget.");
  });

  it("releases a settled child's message and tool budget", () => {
    const { observe, latest } = harness();
    observe(created(CHILD, ROOT));
    for (let index = 0; index < 2_048; index += 1) {
      observe(assistant(CHILD, `assistant-${index}`));
    }
    observe(idle(CHILD), created(GRANDCHILD, ROOT));

    expect(() => observe(assistant(GRANDCHILD, "fresh-assistant"))).not.toThrow();
    expect(latest(GRANDCHILD)).toMatchObject({ status: "running" });
  });
});
