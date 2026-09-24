// @inertia-test-suite portable
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { terminateProcessTreeAndWait, type ProcessTreeTerminator } from "../../src/server/process-lifecycle";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { lifecycleServerSource } from "../helpers/opencode-lifecycle-server";
import { portableFixtureRoot, portableNodeExecutable, removePortableFixture, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

it.each([
  { label: "supplied long password", password: "inertia-fixture-opaque-server-value" },
  { label: "generated password", password: undefined },
  { label: "seven-character password", password: "q7Z2p9A" },
  { label: "one-character password", password: "~" },
  { label: "empty password fallback", password: "" },
  { label: "password within a longer credential", password: "q7Z2p9A", apiKey: "fixture-q7Z2p9A-provider-value" },
  { label: "credentials split by terminal escapes", password: "q7Z2p9A-fixture-secret-value", output: "escape-split" },
  { label: "basic-auth token, URL-encoded and base64 forms", password: "p@ss word#1/fixture", output: "encoded" },
])("redacts launch credentials from startup failure detail ($label)", async ({ password, apiKey, output }) => {
  const root = portableFixtureRoot("OpenCode diagnostic credentials");
  roots.push(root);
  const executable = portableNodeExecutable(root, "opencode");
  const printed = output === "escape-split"
    ? `(value) => value.slice(0, 5) + "\\u001b[0m" + value.slice(5, 9) + "\\u0007" + value.slice(9)`
    : output === "encoded"
      ? `(value) => "Basic " + Buffer.from("opencode:" + value).toString("base64")
        + " " + encodeURIComponent(value) + " " + Buffer.from(value).toString("base64")`
      : "(value) => value";
  writeNodeSubcommand(root, "serve", `
    const printed = ${printed};
    process.stderr.write("fixture startup failed\\n");
    process.stderr.write("provider value " + printed(process.env.OPENAI_API_KEY) + "\\n");
    process.stderr.write("server value " + printed(process.env.OPENCODE_SERVER_PASSWORD) + "\\n");
    process.exitCode = 7;
  `);
  const environment = {
    OPENAI_API_KEY: apiKey ?? "inertia-fixture-opaque-provider-value",
    ...(password === undefined ? {} : { OPENCODE_SERVER_PASSWORD: password }),
  };
  const run = createOpenCodeSdkHarness().start({
    input: nativeProviderRunInput({ providerId: "opencode", conversationId: "failure-credentials",
      cwd: root, prompt: "Start", interactionMode: "build", access: "supervised" }),
    executable, environment, providerNativeToolsAvailable: true,
  });
  const result = await run.result;
  expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true,
    error: "OpenCode server exited during startup.",
    failure: { terminalEvent: "sdk/exception" } });
  expect(result.failure?.technicalDetail).toContain("fixture startup failed");
  expect(result.failure?.technicalDetail).toContain("provider value [redacted]");
  expect(result.failure?.technicalDetail).toContain(output === "encoded"
    ? "server value Basic [redacted] [redacted] [redacted]"
    : "server value [redacted]");
  const serialized = JSON.stringify(result);
  for (const secret of [environment.OPENAI_API_KEY, environment.OPENCODE_SERVER_PASSWORD]) {
    if (!secret) continue;
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
    expect(serialized).not.toContain(Buffer.from(secret).toString("base64"));
    expect(serialized).not.toContain(Buffer.from(`opencode:${secret}`).toString("base64"));
  }
});

it("does not publish the underlying process-tree termination error", async () => {
  const root = portableFixtureRoot("OpenCode cleanup credentials");
  roots.push(root);
  const executable = portableNodeExecutable(root, "opencode");
  writeNodeSubcommand(root, "serve", lifecycleServerSource(root, join(root, "capture.json"), "resume"));
  const credential = "inertia-fixture-opaque-cleanup-value";
  const terminateProcessTree = vi.fn<ProcessTreeTerminator>(async (child, force) => {
    await terminateProcessTreeAndWait(child, force);
    throw new Error(`cleanup cause ${credential}`);
  });
  const statuses: unknown[] = [];
  const run = createOpenCodeSdkHarness({ terminateProcessTree }).start({
    input: nativeProviderRunInput({ providerId: "opencode", conversationId: "cleanup-credentials",
      cwd: root, prompt: "Continue", interactionMode: "build", access: "supervised",
      sessionId: "opencode-lifecycle-session" }),
    executable, environment: { OPENAI_API_KEY: credential }, providerNativeToolsAvailable: true,
    callbacks: { onEvent: (event) => { if (event.type === "status") statuses.push(event); } },
  });
  const result = await run.result;
  expect(terminateProcessTree).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ status: "failed", cleanupConfirmed: false,
    error: "OpenCode server process tree could not be confirmed stopped.",
    failure: { phase: "cleanup", terminalEvent: "process-tree/cleanup" } });
  expect(result.failure?.technicalDetail).toContain("OpenCode server process tree could not be confirmed stopped.");
  expect(statuses.at(-1)).toMatchObject({ status: "failed", message: result.error });
  expect(JSON.stringify({ result, statuses })).not.toContain(credential);
  expect(JSON.stringify({ result, statuses })).not.toContain("cleanup cause");
});
