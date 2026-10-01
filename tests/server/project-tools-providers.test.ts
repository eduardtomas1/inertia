// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { checkClaudeProjectTools, claudeProjectToolOptions, prepareProjectToolLaunch } from "../../src/server/provider/project-tool-launch";
import { observeClaudeProjectTools, observeCodexProjectTool } from "../../src/server/provider/project-tools";
import { projectToolServerName, type ProjectTool } from "../../src/shared/project-tools";
import { launchCredentialValues } from "../../src/server/provider/activity-detail";
import { portableFixtureRoot, portableNodeExecutable, removePortableFixture, waitFor, writeNodeSubcommand } from "../helpers/portable-provider-fixture";
import { claudeSuccessResult, claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { projectToolsCodexFixtureSource } from "../helpers/project-tools-codex-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const connection: ProjectTool = { id: randomUUID(), projectId: randomUUID(), revision: 1, name: "Docs", url: "https://docs.example.com/mcp", bearerTokenEnv: null, providers: ["claude", "codex"] };
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(removePortableFixture)); });
const toolRun = (connections = [connection]) => ({ connections, report: vi.fn(), setRefresh: vi.fn() });

describe("project tools provider authority", () => {
  it("only accepts exact server identity, native connection state and tool names", () => {
    const run = toolRun();
    observeCodexProjectTool(run, connection, { data: [{ name: projectToolServerName(connection.id), authStatus: "unsupported", tools: { search: {} } }] });
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "unavailable", toolNames: [] }));
    observeCodexProjectTool(run, connection, { data: [{ name: projectToolServerName(connection.id), runtimeStatus: "connected", tools: { search: {} }, toolsError: null }], nextCursor: null });
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "available", toolNames: ["search"] }));
    observeClaudeProjectTools(run, [{ name: "some-other-server", status: "connected", tools: [{ name: "search" }] }]);
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "unavailable", toolNames: [] }));
    observeClaudeProjectTools(run, [{ name: projectToolServerName(connection.id), status: "needs-auth", error: "synthetic-sensitive-error", config: { headers: { Authorization: "synthetic-sensitive-header" } } }]);
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "needs-auth", toolNames: [] }));
    expect(JSON.stringify(run.report.mock.calls)).not.toContain("synthetic-sensitive");
    observeClaudeProjectTools(run, null);
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "unavailable" }));
  });

  it("resolves selected tokens privately, excludes missing authentication, and enables existing redaction", async () => {
    const run = { ...toolRun([{ ...connection, bearerTokenEnv: "INERTIA_MCP_DOCS" }]), resolveToken: vi.fn(async () => "synthetic-test-value") };
    const signal = new AbortController().signal;
    const launch = await prepareProjectToolLaunch(run, { PATH: "fixture-path" }, signal);
    expect(run.resolveToken).toHaveBeenCalledWith("INERTIA_MCP_DOCS", signal);
    const key = launch.projectTools!.connections[0]!.bearerTokenEnv!;
    expect(launch.environment[key]).toBe("synthetic-test-value");
    expect(launchCredentialValues(launch.environment)).toContain("synthetic-test-value");
    expect(JSON.stringify(launch.projectTools)).not.toContain("synthetic-test-value");
    const claudeOptions = claudeProjectToolOptions(launch.projectTools);
    expect(JSON.stringify(claudeOptions)).not.toContain("synthetic-test-value");
    expect(claudeOptions.servers[projectToolServerName(connection.id)]).toMatchObject({
      headers: { Authorization: "Bearer ${" + key + "}" },
    });
    const missing = await prepareProjectToolLaunch({ ...run, resolveToken: async () => null }, {}, signal);
    expect(missing.projectTools?.connections).toEqual([]);
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "needs-auth" }));
    const nested = await prepareProjectToolLaunch({ ...run, resolveToken: async () => "synthetic-${OTHER_CREDENTIAL}" }, {}, signal);
    expect(nested.projectTools?.connections).toEqual([]);
    expect(nested.environment).toEqual({});
  });

  it("bounds Claude status requests and ignores replies after cancellation", async () => {
    vi.useFakeTimers();
    const run = toolRun(); const abort = new AbortController();
    const query = { mcpServerStatus: () => new Promise(() => {}) } as unknown as Query;
    const check = checkClaudeProjectTools(query, run, abort.signal);
    await vi.advanceTimersByTimeAsync(5001); await check;
    expect(run.report).toHaveBeenCalledWith(expect.objectContaining({ state: "unavailable" }));
    run.report.mockClear();
    const cancelled = checkClaudeProjectTools(query, run, abort.signal); abort.abort(); await cancelled;
    expect(run.report).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["claude", "codex"])("does not disclose credentials echoed in %s tool names", async (provider) => {
    const token = "synthetic-mcp-token-12345";
    const backendToken = "synthetic-backend-token-67890";
    const run = { ...toolRun([{ ...connection, bearerTokenEnv: "INERTIA_MCP_DOCS" }]), resolveToken: async () => token };
    const launch = await prepareProjectToolLaunch(run, { API_KEY: backendToken }, new AbortController().signal);
    const names = ["search_docs", token, `search_${token}`, Buffer.from(token).toString("base64url"), backendToken];
    const report = (toolNames: string[]) => {
      if (provider === "claude") observeClaudeProjectTools(launch.projectTools!, [{
        name: projectToolServerName(connection.id), status: "connected", tools: toolNames.map((name) => ({ name })),
      }]);
      else observeCodexProjectTool(launch.projectTools!, connection, { data: [{
        name: projectToolServerName(connection.id), runtimeStatus: "connected", tools: Object.fromEntries(toolNames.map((name) => [name, {}])),
      }] });
    };
    report(names);
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "available", toolNames: ["search_docs"] }));
    report(names.slice(1));
    expect(run.report).toHaveBeenLastCalledWith(expect.objectContaining({ state: "unavailable", toolNames: [] }));
    expect(JSON.stringify(run.report.mock.calls)).not.toContain(token);
    expect(JSON.stringify(run.report.mock.calls)).not.toContain(backendToken);
  });

  it.each([true, false])("Claude only installs and reports project tools with native authority=%s", async (native) => {
    const root = portableFixtureRoot("Claude project tools"); roots.push(root);
    const run = toolRun(); let options: Options | undefined;
    const status = vi.fn(async () => [{ name: projectToolServerName(connection.id), status: "connected" as const, tools: [{ name: "search_docs" }] }]);
    const harness = createClaudeAgentSdkHarness({ createQuery: (input) => {
      options = input.options;
      return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
        yield claudeSystem("init");
        yield claudeSuccessResult("Done", "completed");
      })(), { mcpServerStatus: status });
    } });
    const launched = harness.start({ input: nativeProviderRunInput({ providerId: "claude", conversationId: "tools-chat", cwd: root, prompt: "Use docs", interactionMode: "build", access: "supervised" }), executable: process.execPath, environment: {}, providerNativeToolsAvailable: native, projectTools: run });
    expect((await launched.result).status).toBe("completed");
    expect(options?.strictMcpConfig).toBe(native ? true : undefined);
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(native ? [projectToolServerName(connection.id)] : []);
    if (native) {
      expect(options?.managedSettings?.allowedMcpServers).toEqual([{ serverName: projectToolServerName(connection.id) }]);
      expect(run.report).toHaveBeenCalledWith(expect.objectContaining({ state: "available", toolNames: ["search_docs"] }));
    } else expect(status).not.toHaveBeenCalled();
  });

  it.each(["fresh", "resumed", "unsupported"])("Codex sends scoped configuration and probes the opened thread: %s", async (scenario) => {
    const root = portableFixtureRoot("Codex project tools"); roots.push(root);
    const executable = portableNodeExecutable(root, "codex");
    writeNodeSubcommand(root, "app-server", projectToolsCodexFixtureSource);
    const capture = join(root, "capture.jsonl"); const run = toolRun();
    const launched = startCodexAppServerRun({ executable, environment: { ...process.env, INERTIA_TOOL_CAPTURE: capture, INERTIA_TOOL_SCENARIO: scenario }, cwd: root, prompt: "Use docs", planMode: false, access: "supervised", projectTools: run,
      ...(scenario === "resumed" ? { sessionId: "11111111-1111-4111-8111-111111111111" } : {}),
    });
    const result = await launched.result;
    expect(result).toMatchObject({ status: "completed", cleanupConfirmed: true });
    const messages = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const opening = messages.find((message) => message.method === (scenario === "resumed" ? "thread/resume" : "thread/start"));
    expect(opening.params.config[`mcp_servers.${projectToolServerName(connection.id)}`]).toMatchObject({ url: connection.url, enabled: true });
    expect(messages.find((message) => message.method === "mcpServerStatus/list").params.threadId).toBe("11111111-1111-4111-8111-111111111111");
    expect(run.report).toHaveBeenCalledWith(expect.objectContaining({ state: scenario === "unsupported" ? "unavailable" : "available" }));
    expect(result.failure).toBeUndefined();
  });

  it("cleans up Codex cancellation during a stalled tool status request", async () => {
    const root = portableFixtureRoot("cancel project tools"); roots.push(root);
    const executable = portableNodeExecutable(root, "codex"); writeNodeSubcommand(root, "app-server", projectToolsCodexFixtureSource);
    const run = toolRun();
    const launched = startCodexAppServerRun({ executable, environment: { ...process.env, INERTIA_TOOL_SCENARIO: "hang" }, cwd: root, prompt: "Use docs", planMode: false, access: "full", projectTools: run });
    await waitFor("tool status request", () => run.setRefresh.mock.calls.length > 0);
    launched.cancel(false);
    expect(await launched.result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    expect(run.report).not.toHaveBeenCalled();
  });
});
