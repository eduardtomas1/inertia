// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import { isStaleResumeError } from "../../src/server/codex/app-server-config";
import { claudeSessionUnavailable } from "../../src/server/provider/claude-startup-failure";
import { cursorRuntimeFailure } from "../../src/server/provider/cursor-acp-failures";
import { kimiRuntimeFailure } from "../../src/server/provider/kimi-acp-support";
import {
  acpSessionUnavailable,
  openCodeSessionUnavailable,
} from "../../src/server/provider/session-unavailable";

const MIB = 1024 * 1024;

function timed(run: () => unknown): { ms: number; value: unknown } {
  const started = performance.now();
  const value = run();
  return { ms: performance.now() - started, value };
}

describe("session classification cost on 1 MiB adversarial provider text", () => {
  const inputs: Array<[string, string]> = [
    ["repeated session words", "session ".repeat(MIB / 8)],
    ["session followed by 80-char runs", ("session " + "x".repeat(79) + " ").repeat(Math.floor(MIB / 88))],
    ["resource prefix with no terminator", "resource" + " a".repeat(MIB / 2)],
    ["unicode word chars", "sessionéééé ".repeat(MIB / 13)],
    ["no newline no dot", "conversation-" .repeat(MIB / 13)],
  ];
  it.each(inputs)("acpSessionUnavailable stays linear on %s", (_label, text) => {
    const { ms, value } = timed(() => acpSessionUnavailable("session/load", text));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(1_000);
  });

  it("openCodeSessionUnavailable, isStaleResumeError and cursor/kimi failure builders stay bounded", () => {
    const text = "session thread ".repeat(MIB / 15);
    expect(timed(() => openCodeSessionUnavailable({ name: "Error", message: text, data: { message: text } })).ms).toBeLessThan(1_000);
    expect(timed(() => isStaleResumeError(new Error(text))).ms).toBeLessThan(1_000);
    const child = { exitCode: null, signalCode: null } as never;
    expect(timed(() => cursorRuntimeFailure(text, child, "session", "session/load")).ms).toBeLessThan(2_000);
    expect(timed(() => kimiRuntimeFailure(new Error(text), { terminalEvent: "session/load", child: { exitCode: null, signalCode: null } } as never)).ms).toBeLessThan(2_000);
  });
});

describe("unrelated not-found errors during a resume", () => {
  it.each([
    "Session directory /home/user/project does not exist",
    "Failed to load session: working directory /tmp/work does not exist",
    "Invalid session configuration: model gpt-x not found",
    "Resource not found: file:///home/user/project/src/main",
    "Session load failed: MCP server config /home/user/mcp not found",
    "Session load failed: missing field `cwd`",
    "Session C:\\Users\\me\\work not found",
  ])("ACP session/load does not treat %j as an unavailable session", (message) => {
    expect(acpSessionUnavailable("session/load", message)).toBe(false);
  });

  it.each([
    "failed to resume thread: cwd /home/user/project not found",
    "thread/resume: missing field `cwd`",
    "model gpt-x not found for thread",
    "unknown model for thread resume",
    "thread 019f: model gpt-x not found",
    "thread 019f: working directory does not exist",
  ])("Codex does not treat %j as a stale thread", (message) => {
    expect(isStaleResumeError(new Error(message))).toBe(false);
  });

  it("classifies only errors from the session load or resume step", () => {
    const child = { exitCode: null, signalCode: null } as never;
    expect(cursorRuntimeFailure(
      "Tool call failed: This Cursor ACP server does not advertise session resume support.",
      child,
      "turn",
      "session/prompt",
    )).not.toHaveProperty("sessionUnavailable");
    expect(acpSessionUnavailable("session/prompt", "does not advertise session resume support")).toBe(false);
    expect(acpSessionUnavailable("initialize", "does not advertise session resume support")).toBe(false);
    expect(acpSessionUnavailable("session/load", "This Kimi ACP server does not advertise session resume support.")).toBe(true);
  });

  it("does not treat an OpenCode resume error that names a path as a missing session", () => {
    expect(openCodeSessionUnavailable({
      name: "UnknownError",
      data: { message: "Session not found in /home/user/project/.opencode" },
    })).toBe(false);
  });

  it("Claude matching stays narrow", () => {
    const result = (errors: string[], numTurns = 0) => ({
      type: "result", subtype: "error_during_execution", num_turns: numTurns, errors,
    }) as never;
    expect(claudeSessionUnavailable(result(["No conversation found with session ID: abc"]))).toBe(true);
    expect(claudeSessionUnavailable(result(["No conversation found with session ID: abc"], 1))).toBe(false);
    expect(claudeSessionUnavailable(result(["File not found: /x"]))).toBe(false);
    expect(claudeSessionUnavailable(result(["Working directory /x does not exist"]))).toBe(false);
  });
});
