import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeAgentSdkMetadata } from "../../src/server/provider/claude-agent-sdk-metadata";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import { runtimeOwnedProcessCleanupConfirmed } from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";

// Real pinned SDK protocol and native guardian, with no installed provider,
// account, prompt, network service or user configuration in the child.
describe.runIf(process.platform === "darwin")("Claude metadata natural process completion", () => {
  let directory = "";
  let deactivate: (() => void) | null = null;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    // The production cleanup path must settle this exact fixture guardian.
    if (child && child.exitCode === null && child.signalCode === null) {
      await terminateProcessTreeAndWait(child, true);
    }
    const stopped = !child || child.exitCode !== null || child.signalCode !== null;
    deactivate?.();
    deactivate = null;
    if (directory && stopped) await rm(directory, { recursive: true, force: true });
    expect(stopped).toBe(true);
  });

  async function fixture(stall = false, usageError = false) {
    directory = await mkdtemp(join(tmpdir(), "inertia-claude-metadata-"));
    await chmod(directory, 0o700);
    const receipt = join(directory, "receipt.txt");
    const executable = join(directory, "provider.js");
    await writeFile(executable, `
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const record = (value) => appendFileSync(${JSON.stringify(receipt)}, value + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.type === "user") { record("unexpected-prompt"); return; }
  if (message.type !== "control_request") return;
  if (message.request.subtype === "initialize") {
    const helper = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", shell: false });
    await new Promise((resolve, reject) => { helper.once("error", reject); helper.once("close", resolve); });
    record("fork-completed");
    if (process.env.CLAUDE_FIXTURE_STALL === "1") return;
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
      response: { commands: [], models: [{ value: "fixture-sonnet", displayName: "Fixture Sonnet" }], account: {} } } });
  } else if (message.request.subtype === "get_usage") {
    if (process.env.CLAUDE_FIXTURE_USAGE_ERROR === "1") {
      send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "Usage not supported" } });
      return;
    }
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
      response: { rate_limits_available: false } } });
  }
});
input.on("close", () => { record("eof"); });
`);
    const taints: unknown[] = [];
    deactivate = activatePreparedRuntimeOwnedProcessRegistry(directory,
      "20000000-0000-4000-8000-000000000002:1", "test:10000000-0000-4000-8000-000000000001", {
        darwinGuardianPath: join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian"),
        onTainted: (diagnostic) => { taints.push(diagnostic); },
      });
    const spawnProcess = ((...args: Parameters<typeof spawn>) => {
      child = spawn(...args);
      return child;
    }) as typeof spawn;
    const read = (timeoutMs = 6_000, signal?: AbortSignal) => readClaudeAgentSdkMetadata(executable,
      { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: directory,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_FIXTURE_STALL: stall ? "1" : "0", CLAUDE_FIXTURE_USAGE_ERROR: usageError ? "1" : "0" },
      directory, timeoutMs, undefined, ["models", "rateLimits"], { spawnProcess }, signal);
    return { read, receipt, taints };
  }

  it.each([false, true])("finishes a forked metadata child through EOF, including partial results (usage error: %s)", async (usageError) => {
    const { read, receipt, taints } = await fixture(false, usageError);
    const result = await read();
    expect(result.models).toMatchObject([{ id: "fixture-sonnet" }]);
    if (usageError) {
      expect(result.rateLimits).toBeUndefined();
      expect(result.rateLimitsUnavailable).toBeUndefined();
    } else expect(result).toMatchObject({ rateLimits: [], rateLimitsUnavailable: true });
    expect(await readFile(receipt, "utf8")).toBe("fork-completed\neof\n");
    expect(child?.exitCode).toBe(0);
    expect(child?.signalCode).toBeNull();
    expect(taints).toEqual([]);
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(true);
  });

  it.each(["timeout", "cancel"])("retains unconfirmed fork cleanup on metadata %s", async (reason) => {
    const { read, receipt, taints } = await fixture(true);
    const controller = new AbortController();
    const pending = read(6_000, controller.signal);
    // Attach rejection handling before any awaited fixture observation.
    const assertion = expect(pending).rejects.toThrow("could not be confirmed stopped");
    const deadline = Date.now() + 5_000;
    while (!await readFile(receipt, "utf8").catch(() => "") && Date.now() < deadline) await sleep(10);
    expect(await readFile(receipt, "utf8")).toBe("fork-completed\n");
    if (reason === "cancel") controller.abort();
    await assertion;
    expect(taints).toContainEqual(expect.objectContaining({ stage: "darwin-guardian-close", signal: "SIGUSR2" }));
    expect(runtimeOwnedProcessCleanupConfirmed()).toBe(false);
    expect(child?.signalCode).toBe("SIGUSR2");
  });
});
