// @inertia-test-suite portable
// @inertia-harness antigravity-cli
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_CLI_CAPABILITIES,
  createAntigravityCliHarness,
  type AntigravityCliHarnessOptions,
} from "../../src/server/provider/antigravity-cli-harness";
import {
  ANTIGRAVITY_AUTH_REQUIRED_MESSAGE,
  ANTIGRAVITY_HEADLESS_ARGUMENTS,
  antigravityArguments,
  antigravityResultFailure,
  antigravityUserLine,
  parseAntigravityLine,
} from "../../src/server/provider/antigravity-stream";
import type {
  ProviderActivityEvent,
  ProviderSessionEvent,
  ProviderStatusEvent,
  ProviderUsageEvent,
} from "../../src/server/provider/contracts";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-processes";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  portableFixtureRoot,
  removePortableFixture,
  waitFor,
  writeNodeFlagExecutable,
} from "../helpers/portable-provider-fixture";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";
import { executableProcessExists } from "../helpers/executable-process";
import { nativeProviderRunInput } from "./model-route-fixture";

const CONVERSATION = "4f2c8a8e-3b7d-4a51-9a39-5c2d7e1f0a11";
const PROMPT_FLAGS = new Set(["-p", "--print", "--prompt", "--prompt-interactive", "-i"]);

const CLOSE_STDOUT_SOURCE = `
const stdoutFd = process.stdout.fd;
const realStdoutDestroy = Object.getPrototypeOf(process.stdout)._destroy;
if (typeof realStdoutDestroy !== "function") throw new Error("Node stdout is not a pipe-backed Socket.");
process.stdout._destroy = realStdoutDestroy;
process.stdout.destroy();
require("node:fs").closeSync(stdoutFd);
`;

const roots: string[] = [];

function terminalStatuses(): { statuses: string[]; onStatus: (event: ProviderStatusEvent) => void } {
  const statuses: string[] = [];
  return {
    statuses,
    onStatus: (event) => {
      if (event.status === "completed" || event.status === "failed" || event.status === "cancelled") {
        statuses.push(event.status);
      }
    },
  };
}

const registryDeactivators: Array<() => void> = [];

afterEach(async () => {
  while (registryDeactivators.length > 0) registryDeactivators.pop()?.();
  await Promise.all(roots.splice(0).map((root) => removePortableFixture(root)));
});

function ownedProcessRegistry(root: string, label: string): {
  journal: RuntimeOwnedProcessJournal;
  runtimeGenerationId: string;
} {
  const registryRoot = join(root, "runtime-owned");
  mkdirSync(registryRoot, { recursive: true });
  chmodSync(registryRoot, 0o700);
  const runtimeGenerationId = `62000000-0000-4000-8000-${label}:1`;
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
    registryRoot,
    runtimeGenerationId,
    `test:62000000-0000-4000-8000-${label}`,
    process.platform === "darwin" || process.platform === "linux"
      ? {
          darwinGuardianPath: join(
            process.cwd(),
            "resources/generated/runtime-process-guardian/runtime-process-guardian",
          ),
        }
      : {},
  );
  if (deactivate) registryDeactivators.push(deactivate);
  return { journal: new RuntimeOwnedProcessJournal(registryRoot), runtimeGenerationId };
}

function fixtureRoot(label: string): string {
  const root = portableFixtureRoot(label);
  roots.push(root);
  return root;
}

function fakeAgy(root: string, body: string): { command: string; capturePath: string } {
  const capturePath = join(root, "capture.json");
  const command = writeNodeFlagExecutable(root, "agy", `
const fs = require("node:fs");
const capture = { argv: process.argv.slice(2), stdin: "" };
const save = () => fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(capture));
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const hang = () => setInterval(() => undefined, 1000);
save();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { capture.stdin += chunk; save(); });
process.stdin.on("end", () => {
${body}
});
`);
  return { command, capturePath };
}

function captured(capturePath: string): { argv: string[]; stdin: string } {
  return JSON.parse(readFileSync(capturePath, "utf8")) as { argv: string[]; stdin: string };
}

function managerFor(command: string, options: AntigravityCliHarnessOptions = {}): ProviderManager {
  return ProviderManager.createForTests(
    { commands: { antigravity: command } },
    new AgentHarnessRegistry([createAntigravityCliHarness(options)]),
  );
}

function antigravityInput(
  root: string,
  overrides: Partial<Parameters<typeof nativeProviderRunInput>[0]> = {},
) {
  return nativeProviderRunInput({
    providerId: "antigravity",
    conversationId: "antigravity-test",
    cwd: root,
    prompt: "Inspect the change",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  });
}

function routeInput(
  overrides: Partial<Parameters<typeof nativeProviderRunInput>[0]> = {},
) {
  return antigravityInput("/workspace", overrides);
}

const SUCCESS_USAGE = {
  input_tokens: 120,
  output_tokens: 30,
  thinking_tokens: 5,
  cache_read_tokens: 10,
  total_tokens: 165,
};

describe("Antigravity headless arguments", () => {
  it("always requests stream-json input and output and never the OAuth-capable prompt flag", () => {
    const routes = [
      routeInput(),
      routeInput({ access: "auto-edit" }),
      routeInput({ access: "full" }),
      routeInput({ interactionMode: "plan", access: "full" }),
      routeInput({ sessionId: CONVERSATION, model: "fixture-model", reasoningEffort: "high" }),
    ];
    for (const input of routes) {
      const args = antigravityArguments(input);
      expect(args.slice(0, 4)).toEqual([...ANTIGRAVITY_HEADLESS_ARGUMENTS]);
      expect(args.some((arg) => PROMPT_FLAGS.has(arg))).toBe(false);
      expect(args).not.toContain(input.prompt);
    }
  });

  it("maps access, plan, effort, model, and resume onto documented flags only", () => {
    expect(antigravityArguments(routeInput())).toEqual([...ANTIGRAVITY_HEADLESS_ARGUMENTS]);
    expect(antigravityArguments(routeInput({ access: "auto-edit" })).slice(4))
      .toEqual(["--mode", "accept-edits"]);
    expect(antigravityArguments(routeInput({ access: "full" })).slice(4))
      .toEqual(["--dangerously-skip-permissions"]);
    expect(antigravityArguments(routeInput({ interactionMode: "plan", access: "full" })).slice(4))
      .toEqual(["--mode", "plan"]);
    expect(antigravityArguments(routeInput({
      sessionId: CONVERSATION,
      model: "fixture-model",
      reasoningEffort: "medium",
    })).slice(4)).toEqual([
      "--conversation", CONVERSATION,
      "--model", "fixture-model",
      "--effort", "medium",
    ]);
  });

  it("drops unsafe resume identities, model names, and unknown efforts", () => {
    expect(antigravityArguments(routeInput({
      sessionId: "--dangerously-skip-permissions",
      model: "-p",
      reasoningEffort: "maximum",
    }))).toEqual([...ANTIGRAVITY_HEADLESS_ARGUMENTS]);
    expect(antigravityArguments(routeInput({ model: "fixture model; rm -rf" })))
      .toEqual([...ANTIGRAVITY_HEADLESS_ARGUMENTS]);
  });

  it("sends the prompt as one stream-json user event on stdin", () => {
    const line = antigravityUserLine("Line one\nLine two");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({
      event: "user",
      message: { content: "Line one\nLine two" },
    });
  });
});

describe("Antigravity stream parsing", () => {
  it("accepts nested and flat step updates", () => {
    const nested = parseAntigravityLine(JSON.stringify({
      event: "step_update",
      step_update: { conversation_id: CONVERSATION, step_index: 0, state: "ACTIVE", text_delta: "Hi" },
    }));
    const flat = parseAntigravityLine(JSON.stringify({
      event: "step_update",
      conversation_id: CONVERSATION,
      step_index: 0,
      state: "ACTIVE",
      text_delta: "Hi",
    }));
    expect(nested).toEqual([
      { kind: "session", conversationId: CONVERSATION },
      { kind: "text", text: "Hi" },
    ]);
    expect(flat).toEqual(nested);
  });

  it("maps tool steps to started and completed activity with a stable identity", () => {
    expect(parseAntigravityLine(JSON.stringify({
      event: "step_update",
      step_update: { step_index: 4, state: "ACTIVE", tool_name: "run_command" },
    }))).toEqual([{ kind: "tool", id: "4", label: "run_command", phase: "started" }]);
    expect(parseAntigravityLine(JSON.stringify({
      event: "step_update",
      step_update: { step_index: 4, state: "DONE", tool_name: "run_command" },
    }))).toEqual([{ kind: "tool", id: "4", label: "run_command", phase: "completed" }]);
  });

  it("reads the documented result envelope and ignores unknown events", () => {
    expect(parseAntigravityLine(JSON.stringify({
      event: "result",
      result: {
        conversation_id: CONVERSATION,
        status: "SUCCESS",
        response: "Done",
        error: "",
        usage: SUCCESS_USAGE,
      },
    }))).toEqual([{
      kind: "result",
      result: {
        status: "SUCCESS",
        conversationId: CONVERSATION,
        response: "Done",
        error: null,
        usage: expect.objectContaining({
          inputTokens: 120,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          cachedInputTokens: 10,
          totalProcessedTokens: 165,
          totalProcessedScope: "session",
        }),
      },
    }]);
    expect(parseAntigravityLine(JSON.stringify({ event: "init", init: {} }))).toEqual([]);
    expect(parseAntigravityLine(JSON.stringify({ event: "future_event" }))).toEqual([]);
  });

  it("rejects malformed lines", () => {
    for (const line of ["not json", "[]", "{}", JSON.stringify({ event: 3 })]) {
      expect(parseAntigravityLine(line)).toBeNull();
    }
  });

  it("maps every non-success result status to a failure", () => {
    const result = (status: string, error: string | null = null) => ({
      status,
      conversationId: null,
      response: "",
      error,
      usage: null,
    });
    expect(antigravityResultFailure(result("SUCCESS"), "/workspace")).toBeNull();
    expect(antigravityResultFailure(result("ERROR", "authentication failed or timed out"), "/workspace"))
      .toMatchObject({ phase: "auth", message: ANTIGRAVITY_AUTH_REQUIRED_MESSAGE, terminalEvent: "result:auth" });
    expect(antigravityResultFailure(result("ERROR", "Model quota is exhausted."), "/workspace"))
      .toMatchObject({ phase: "turn", reason: "provider-error", terminalEvent: "result:error" });
    expect(antigravityResultFailure(result("WAITING"), "/workspace"))
      .toMatchObject({ terminalEvent: "result:waiting" });
    expect(antigravityResultFailure(result("INVALID"), "/workspace"))
      .toMatchObject({ message: "Antigravity rejected the request.", terminalEvent: "result:invalid" });
    for (const status of ["CANCELED", "INTERRUPTED", "RUNNING", ""]) {
      expect(antigravityResultFailure(result(status), "/workspace"))
        .toMatchObject({ terminalEvent: "result:stopped" });
    }
  });
});

describe("Antigravity CLI harness", { concurrent: false }, () => {
  it("declares headless limits truthfully", () => {
    expect(ANTIGRAVITY_CLI_CAPABILITIES.extension).toMatchObject({
      protocol: "headless-stream-json",
      approvals: "provider-policy",
      questions: "unavailable-in-headless",
      images: "unavailable-in-current-harness",
    });
  });

  it("streams a completed turn with session identity, tools, and usage", async () => {
    const root = fixtureRoot("antigravity success");
    const { command, capturePath } = fakeAgy(root, `
emit({ event: "init", init: { conversation_id: ${JSON.stringify(CONVERSATION)} } });
emit({ event: "step_update", step_update: { conversation_id: ${JSON.stringify(CONVERSATION)}, step_index: 0, state: "ACTIVE", text_delta: "Hello " } });
emit({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", tool_name: "view_file" } });
emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", tool_name: "view_file" } });
emit({ event: "step_update", step_update: { step_index: 2, state: "DONE", text_delta: "world" } });
emit({ event: "result", result: { conversation_id: ${JSON.stringify(CONVERSATION)}, status: "SUCCESS", response: "Hello world", error: "", duration_seconds: 1, num_turns: 1, usage: ${JSON.stringify(SUCCESS_USAGE)} } });
process.exit(0);
`);
    const sessions: ProviderSessionEvent[] = [];
    const activities: ProviderActivityEvent[] = [];
    const usage: ProviderUsageEvent[] = [];
    const result = await managerFor(command).run(antigravityInput(root), {
      onSession: (event) => sessions.push(event),
      onActivity: (event) => activities.push(event),
      onUsage: (event) => usage.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "Hello world",
      sessionId: CONVERSATION,
      cleanupConfirmed: true,
    });
    expect(sessions.map((event) => event.sessionId)).toEqual([CONVERSATION]);
    expect(activities.filter((event) => event.kind === "tool").map((event) => [
      event.phase,
      event.label,
    ])).toEqual([["started", "view_file"], ["completed", "view_file"]]);
    expect(new Set(activities.filter((event) => event.kind === "tool")
      .map((event) => event.activityId)).size).toBe(1);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.usage).toMatchObject({ inputTokens: 120, outputTokens: 30 });
    const capture = captured(capturePath);
    expect(capture.argv).toEqual([...ANTIGRAVITY_HEADLESS_ARGUMENTS]);
    expect(capture.stdin).toBe(antigravityUserLine("Inspect the change"));
  });

  it("resumes the recorded conversation and applies the selected access mode", async () => {
    const root = fixtureRoot("antigravity resume");
    const { command, capturePath } = fakeAgy(root, `
emit({ event: "result", result: { conversation_id: ${JSON.stringify(CONVERSATION)}, status: "SUCCESS", response: "Resumed", error: "" } });
process.exit(0);
`);
    const result = await managerFor(command).run(antigravityInput(root, {
      sessionId: CONVERSATION,
      access: "auto-edit",
    }));
    expect(result).toMatchObject({ status: "completed", text: "Resumed", sessionId: CONVERSATION });
    expect(captured(capturePath).argv).toEqual([
      ...ANTIGRAVITY_HEADLESS_ARGUMENTS,
      "--conversation", CONVERSATION,
      "--mode", "accept-edits",
    ]);
  });

  it.each((["resumed", "new"] as const).flatMap((kind) =>
    (["text", "tool", "result"] as const).map((event) => ({ kind, event }))))(
    "rejects a foreign conversation $event in a $kind run before projecting it",
    async ({ kind, event }) => {
      const root = fixtureRoot("antigravity foreign conversation");
      const foreign = "5f2c8a8e-3b7d-4a51-9a39-5c2d7e1f0a12";
      const { command } = fakeAgy(root, `
${kind === "new" ? `emit({ event: "init", init: { conversation_id: ${JSON.stringify(CONVERSATION)} } });` : ""}
emit(${JSON.stringify(event === "result"
  ? { event: "result", result: { conversation_id: foreign, status: "SUCCESS", response: "Foreign answer" } }
  : { event: "step_update", step_update: { conversation_id: foreign, step_index: 1,
    ...(event === "text" ? { text_delta: "Foreign answer" } : { tool_name: "foreign_tool", state: "ACTIVE" }) } })});
emit({ event: "result", result: { status: "SUCCESS", response: "Later answer" } });
process.exit(0);
`);
      const text: string[] = [];
      const sessions: string[] = [];
      const activities: string[] = [];
      const result = await managerFor(command).run(antigravityInput(root,
        kind === "resumed" ? { sessionId: CONVERSATION } : {}), {
        onText: (event) => text.push(event.text),
        onSession: (event) => sessions.push(event.sessionId),
        onActivity: (event) => { if (event.kind === "tool") activities.push(event.label); },
      });
      expect(result).toMatchObject({ status: "failed", sessionId: CONVERSATION, cleanupConfirmed: true });
      expect(text).toEqual([]);
      expect(activities).toEqual([]);
      expect(sessions).not.toContain(foreign);
    },
  );

  it.each(["resumed", "new"] as const)("accepts ID-less continuation frames in a %s run", async (kind) => {
    const root = fixtureRoot("antigravity ID-less continuation");
    const { command } = fakeAgy(root, `
${kind === "new" ? `emit({ event: "init", init: { conversation_id: ${JSON.stringify(CONVERSATION)} } });` : ""}
emit({ event: "step_update", step_update: { text_delta: "Valid answer" } });
emit({ event: "result", result: { status: "SUCCESS", response: "Valid answer" } });
process.exit(0);
`);
    await expect(managerFor(command).run(antigravityInput(root,
      kind === "resumed" ? { sessionId: CONVERSATION } : {}))).resolves.toMatchObject({
      status: "completed", sessionId: CONVERSATION, text: "Valid answer", cleanupConfirmed: true,
    });
  });

  it("fails fast into the Connect prompt when Antigravity reports missing sign-in", async () => {
    const root = fixtureRoot("antigravity auth");
    const { command } = fakeAgy(root, `
process.stderr.write("authentication required. Run 'antigravity' to log in\\n");
hang();
`);
    const startedAt = Date.now();
    const result = await managerFor(command).run(antigravityInput(root));
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result).toMatchObject({
      status: "failed",
      error: ANTIGRAVITY_AUTH_REQUIRED_MESSAGE,
      failure: { phase: "auth", terminalEvent: "result:auth" },
      cleanupConfirmed: true,
    });
  });

  it("maps the unauthenticated result envelope to the Connect prompt", async () => {
    const root = fixtureRoot("antigravity auth result");
    const { command } = fakeAgy(root, `
emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } } });
process.exit(1);
`);
    const usage: ProviderUsageEvent[] = [];
    const result = await managerFor(command).run(antigravityInput(root), {
      onUsage: (event) => usage.push(event),
    });
    expect(result).toMatchObject({
      status: "failed",
      error: ANTIGRAVITY_AUTH_REQUIRED_MESSAGE,
      failure: { phase: "auth" },
      cleanupConfirmed: true,
    });
    expect(usage).toEqual([]);
  });

  it("reports declined approvals and still completes the turn", async () => {
    const root = fixtureRoot("antigravity declined");
    const { command } = fakeAgy(root, `
process.stderr.write("Tool run_command was soft-denied because it requires approval\\n");
emit({ event: "result", result: { status: "SUCCESS", response: "Skipped the command", error: "" } });
setTimeout(() => process.exit(0), 50);
`);
    const activities: ProviderActivityEvent[] = [];
    const result = await managerFor(command).run(antigravityInput(root), {
      onActivity: (event) => activities.push(event),
    });
    expect(result.status).toBe("completed");
    expect(activities).toContainEqual(expect.objectContaining({
      kind: "system",
      phase: "info",
      label: "Antigravity declined an action that needs approval",
    }));
  });

  it("fails closed and stops the process on malformed output", async () => {
    const root = fixtureRoot("antigravity malformed");
    const { command } = fakeAgy(root, `
process.stdout.write("this is not stream-json\\n");
hang();
`);
    await expect(managerFor(command).run(antigravityInput(root))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol" },
      cleanupConfirmed: true,
    });
  });

  it("fails closed and stops the process when Antigravity floods its output", async () => {
    const root = fixtureRoot("antigravity flood");
    const { command } = fakeAgy(root, `
const line = JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "ACTIVE", text_delta: "." } }) + "\\n";
process.stdout.write(line.repeat(9_000));
hang();
`);
    await expect(managerFor(command).run(antigravityInput(root))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "malformed-protocol", message: expect.stringMatching(/exceeded the bounded event/u) },
      cleanupConfirmed: true,
    });
  });

  it("fails a clean exit that sent no result", async () => {
    const root = fixtureRoot("antigravity exit zero");
    const { command } = fakeAgy(root, `
emit({ event: "step_update", step_update: { step_index: 0, state: "ACTIVE", text_delta: "Partial" } });
`);
    const recorder = terminalStatuses();
    await expect(managerFor(command).run(antigravityInput(root), { onStatus: recorder.onStatus }))
      .resolves.toMatchObject({
        status: "failed",
        text: "Partial",
        exitCode: 0,
        error: "Antigravity exited without a result (code 0).",
        failure: { reason: "process-exit", terminalEvent: "result:exit" },
        cleanupConfirmed: true,
      });
    expect(recorder.statuses).toEqual(["failed"]);
  });

  it("fails a non-zero exit without a result and keeps the stderr tail", async () => {
    const root = fixtureRoot("antigravity exit code");
    const { command } = fakeAgy(root, `
process.stderr.write("warming up\\nfatal: backend unavailable\\n");
process.exitCode = 3;
`);
    const result = await managerFor(command).run(antigravityInput(root));
    expect(result).toMatchObject({
      status: "failed",
      exitCode: 3,
      error: "Antigravity exited without a result (code 3).",
      failure: { reason: "process-exit" },
      cleanupConfirmed: true,
    });
    expect(result.failure?.technicalDetail).toContain("fatal: backend unavailable");
  });

  it("fails a signal kill without a result", async () => {
    const root = fixtureRoot("antigravity signal kill");
    const { command } = fakeAgy(root, `
process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "ACTIVE", text_delta: "Partial" } }) + "\\n",
  () => process.kill(process.pid, "SIGKILL"));
`);
    const recorder = terminalStatuses();
    const result = await managerFor(command).run(antigravityInput(root), { onStatus: recorder.onStatus });
    expect(result).toMatchObject({ status: "failed", text: "Partial", cleanupConfirmed: true });
    if (process.platform === "win32") {
      expect(result.error).toMatch(/^Antigravity exited without a result \(code \d+\)\.$/u);
    } else {
      expect(result).toMatchObject({
        signal: "SIGKILL",
        error: "Antigravity exited without a result (signal SIGKILL).",
        failure: { reason: "process-signal", terminalEvent: "result:signal" },
      });
    }
    expect(recorder.statuses).toEqual(["failed"]);
  });

  it("uses the terminal result even when the process then exits with an error code", async () => {
    const root = fixtureRoot("antigravity result then exit");
    const { command } = fakeAgy(root, `
emit({ event: "result", result: { status: "SUCCESS", response: "Done", error: "" } });
process.exitCode = 7;
`);
    const recorder = terminalStatuses();
    await expect(managerFor(command).run(antigravityInput(root), { onStatus: recorder.onStatus }))
      .resolves.toMatchObject({ status: "completed", text: "Done", exitCode: 7, cleanupConfirmed: true });
    expect(recorder.statuses).toEqual(["completed"]);
  });

  it("fails and stops Antigravity when it closes its output without a result", async () => {
    const root = fixtureRoot("antigravity output closed");
    const { command } = fakeAgy(root, process.platform === "win32" ? `
emit({ event: "step_update", step_update: { step_index: 0, state: "ACTIVE", text_delta: "Partial" } });
process.stdout.end(() => process.exit(0));
` : `
process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 0, state: "ACTIVE", text_delta: "Partial" } }) + "\\n", () => {
  ${CLOSE_STDOUT_SOURCE}
  hang();
});
`);
    const startedAt = Date.now();
    const recorder = terminalStatuses();
    const result = await managerFor(command).run(antigravityInput(root), { onStatus: recorder.onStatus });
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result).toMatchObject({ status: "failed", text: "Partial", cleanupConfirmed: true });
    expect(result.error).toBe(process.platform === "win32"
      ? "Antigravity exited without a result (code 0)."
      : "Antigravity closed its output without a result.");
    expect(recorder.statuses).toEqual(["failed"]);
  });

  it("keeps a result that arrived before the output closed", async () => {
    const root = fixtureRoot("antigravity result then output closed");
    const { command } = fakeAgy(root, process.platform === "win32" ? `
emit({ event: "result", result: { status: "SUCCESS", response: "Done", error: "" } });
process.stdout.end(() => process.exit(0));
` : `
process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Done", error: "" } }) + "\\n", () => {
  ${CLOSE_STDOUT_SOURCE}
  hang();
});
`);
    await expect(managerFor(command, { resultExitGraceMs: 50 }).run(antigravityInput(root)))
      .resolves.toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
  });

  it("settles instead of hanging when stopping a lingering process cannot be confirmed", async () => {
    const root = fixtureRoot("antigravity unconfirmed cleanup");
    const pidPath = join(root, "agy.pid");
    const { command } = fakeAgy(root, `
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
emit({ event: "result", result: { status: "SUCCESS", response: "Done", error: "" } });
hang();
`);
    const startedAt = Date.now();
    const recorder = terminalStatuses();
    try {
      const result = await managerFor(command, {
        resultExitGraceMs: 50,
        terminateProcessTree: () => new Promise<boolean>(() => undefined),
        terminationConfirmMs: 200,
      }).run(antigravityInput(root), { onStatus: recorder.onStatus });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(result).toMatchObject({
        status: "failed",
        cleanupConfirmed: false,
        error: "Antigravity's process tree could not be confirmed stopped.",
      });
      expect(recorder.statuses).toEqual(["failed"]);
    } finally {
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8")) : 0;
      if (pid > 0 && executableProcessExists(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("reports a non-success result as a failed turn", async () => {
    const root = fixtureRoot("antigravity waiting");
    const { command } = fakeAgy(root, `
emit({ event: "result", result: { status: "WAITING", response: "", error: "" } });
process.exit(0);
`);
    await expect(managerFor(command).run(antigravityInput(root))).resolves.toMatchObject({
      status: "failed",
      failure: { terminalEvent: "result:waiting" },
    });
  });

  it("stops a process that lingers after its result", async () => {
    const root = fixtureRoot("antigravity lingering");
    const { command } = fakeAgy(root, `
emit({ event: "result", result: { status: "SUCCESS", response: "Done", error: "" } });
hang();
`);
    await expect(managerFor(command, { resultExitGraceMs: 50 }).run(antigravityInput(root)))
      .resolves.toMatchObject({ status: "completed", text: "Done", cleanupConfirmed: true });
  });

  it("cancels a running turn by stopping its process tree", async () => {
    const root = fixtureRoot("antigravity cancel");
    const { command } = fakeAgy(root, `
emit({ event: "step_update", step_update: { step_index: 0, state: "ACTIVE", text_delta: "Working" } });
hang();
`);
    const manager = managerFor(command);
    const input = antigravityInput(root, { conversationId: "antigravity-cancel" });
    const result = await manager.run(input, {
      onText: () => {
        manager.cancel(input.conversationId);
      },
    });
    expect(result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
  });

  it("retires the runtime guardian's claim when agy exits on its own after a result", async () => {
    const root = fixtureRoot("antigravity owned natural exit");
    const { journal, runtimeGenerationId } = ownedProcessRegistry(root, "000000000062");
    const { command } = fakeAgy(root, `
emit({ event: "result", result: { status: "SUCCESS", response: "Done", error: "" } });
process.stdout.write("", () => process.exit(0));
`);
    const recorder = terminalStatuses();
    await expect(managerFor(command).run(antigravityInput(root, {
      conversationId: "antigravity-owned-natural-exit",
    }), { onStatus: recorder.onStatus })).resolves.toMatchObject({
      status: "completed",
      text: "Done",
      cleanupConfirmed: true,
    });
    expect(recorder.statuses).toEqual(["completed"]);
    await waitFor(
      "the Antigravity runtime-owned process claim to retire",
      () => journal.records(runtimeGenerationId)?.length === 0,
    );
  });

  it("retires the runtime guardian's claim when a running turn is cancelled", async () => {
    const root = fixtureRoot("antigravity owned cancel");
    const { journal, runtimeGenerationId } = ownedProcessRegistry(root, "000000000063");
    const { command } = fakeAgy(root, `
emit({ event: "step_update", step_update: { step_index: 0, state: "ACTIVE", text_delta: "Working" } });
hang();
`);
    const manager = managerFor(command);
    const input = antigravityInput(root, { conversationId: "antigravity-owned-cancel" });
    await expect(manager.run(input, {
      onText: () => {
        manager.cancel(input.conversationId);
      },
    })).resolves.toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    await waitFor(
      "the cancelled Antigravity runtime-owned process claim to retire",
      () => journal.records(runtimeGenerationId)?.length === 0,
    );
  });

  it("rejects images and compaction without starting Antigravity", async () => {
    const root = fixtureRoot("antigravity unsupported");
    const command = join(root, "must-not-spawn");
    const manager = managerFor(command);
    await expect(manager.run(antigravityInput(root, {
      imagePaths: [join(root, "image.png")],
    }))).resolves.toMatchObject({
      status: "failed",
      error: "Image input is unavailable for Antigravity in Inertia.",
      cleanupConfirmed: true,
    });
    await expect(manager.compact(antigravityInput(root, {
      sessionId: CONVERSATION,
    }), "retain facts")).resolves.toMatchObject({
      providerId: "antigravity",
      status: "failed",
      instructionForwarded: false,
      cleanupConfirmed: true,
    });
    expect(existsSync(command)).toBe(false);
  });
});
