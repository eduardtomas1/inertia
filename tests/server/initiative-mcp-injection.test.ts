// @inertia-test-suite portable
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Options as ClaudeOptions, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type {
  ProviderHostToolBridge,
  ProviderInitiativeMcpPlan,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createKimiAcpHarness } from "../../src/server/provider/kimi-acp-harness";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { AgentHarnessRegistry, ProviderManager, type AgentHarness } from "../../src/server/providers";
import { createInitiativeMcpResolver } from "../../src/server/runtime/initiative-mcp-runtime";
import { initiativeMcpSecretReference } from "../../src/node/initiative-mcp-secret-reference";
import {
  INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES,
  MAX_INITIATIVE_MCP_ARG_CHARS,
  MAX_INITIATIVE_MCP_SERVERS,
  initiativeMcpServerDestination,
  initiativeMcpServersSchema,
  type InitiativeMcpServer,
} from "../../src/shared/initiative-mcp";
import { executableProcessExists } from "../helpers/executable-process";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeClaudeExecutable,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { nativeProviderRunInput } from "./model-route-fixture";

/*
 * Deterministic provider fixtures for initiative MCP servers on every harness
 * that takes them: the server reaches the native request, a provider that
 * rejects it fails or reports cleanly, cancellation while it connects settles,
 * resolved secrets never surface in Inertia's events or results, and stdio
 * servers (the provider's own children) end with the provider's process tree.
 */

const INITIATIVE = "11111111-1111-4111-8111-111111111111";
const HTTP_ID = "22222222-2222-4222-8222-222222222222";
const STDIO_ID = "33333333-3333-4333-8333-333333333333";
const HEADER_SECRET = "fixture-mcp-header-secret-c41f";
const ENV_SECRET = "fixture-mcp-env-secret-0b9e";

const roots: string[] = [];
const managers: ProviderManager[] = [];
const childPids: number[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  for (const pid of childPids.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

const hostTools: ProviderHostToolBridge = {
  definitions: [{
    name: "inertia_browser_tabs",
    description: "List the shared Inertia Browser pages for this chat.",
    inputSchema: { type: "object", additionalProperties: false },
    inputValidator: z.object({}).strict(),
    readOnly: true,
  }],
  invoke: async () => ({ success: true, text: "{}" }),
};

function servers(options: { stdio?: boolean; http?: boolean } = {}): InitiativeMcpServer[] {
  return [
    ...(options.http === false ? [] : [{
      id: HTTP_ID,
      name: "tracker",
      enabled: true,
      transport: {
        kind: "http" as const,
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", secret: true as const }, { name: "X-Team", value: "checkout" }],
      },
    }]),
    ...(options.stdio === false ? [] : [{
      id: STDIO_ID,
      name: "docs",
      enabled: true,
      transport: {
        kind: "stdio" as const,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: [{ name: "DOCS_TOKEN", secret: true as const }, { name: "DOCS_REGION", value: "eu" }],
      },
    }]),
  ];
}

function plan(options?: Parameters<typeof servers>[0]): ProviderInitiativeMcpPlan {
  return { initiativeId: INITIATIVE, servers: initiativeMcpServersSchema.parse(servers(options)) };
}

/** The vault references main derives for the two servers' secrets. */
const [HTTP_SERVER, STDIO_SERVER] = initiativeMcpServersSchema.parse(servers());
const HTTP_REFERENCE = initiativeMcpSecretReference(INITIATIVE, HTTP_ID, "header:authorization", initiativeMcpServerDestination(HTTP_SERVER!));
const STDIO_REFERENCE = initiativeMcpSecretReference(INITIATIVE, STDIO_ID, "env:DOCS_TOKEN", initiativeMcpServerDestination(STDIO_SERVER!));

/** The runtime's resolver over an in-memory vault that holds both secrets. */
const resolveInitiativeMcpServers = createInitiativeMcpResolver({
  resolve: async (reference) => {
    if (reference === HTTP_REFERENCE) return `Bearer ${HEADER_SECRET}`;
    if (reference === STDIO_REFERENCE) return ENV_SECRET;
    return null;
  },
  forget: async () => false,
});

/**
 * A stdio server's variables as the provider received them: the user's own
 * last, after an empty value for every launch credential it would otherwise
 * inherit from the provider (Inertia's sign-in names at least).
 */
function expectInheritedCredentialsBlanked(env: ReadonlyArray<{ name: string; value: string }>): void {
  const own = env.slice(-2);
  expect(own).toEqual([{ name: "DOCS_TOKEN", value: ENV_SECRET }, { name: "DOCS_REGION", value: "eu" }]);
  const blanks = env.slice(0, -2);
  expect(blanks.every(({ value }) => value === "")).toBe(true);
  expect(blanks.map(({ name }) => name)).toEqual(expect.arrayContaining([...INITIATIVE_MCP_INERTIA_CREDENTIAL_ENV_NAMES]));
}

function entries(record: Record<string, string> | undefined): Array<{ name: string; value: string }> {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}

function manager(commands: Record<string, string>, harness?: AgentHarness): ProviderManager {
  const created = ProviderManager.createForTests(
    { commands, cancelGraceMs: 200, resolveInitiativeMcpServers },
    harness ? new AgentHarnessRegistry([harness]) : undefined,
  );
  managers.push(created);
  return created;
}

interface Observed {
  events: unknown[];
  activities: string[];
}

function observer(): Observed & { callbacks: Parameters<ProviderManager["run"]>[1] } {
  const events: unknown[] = [];
  const activities: string[] = [];
  return {
    events,
    activities,
    callbacks: {
      onEvent: (event) => { events.push(event); },
      onActivity: (event) => { activities.push(event.label); },
    },
  };
}

function input(
  providerId: ProviderRunInput["providerId"],
  root: string,
  label: string,
  overrides: Partial<ProviderRunInput> = {},
): ProviderRunInput {
  return nativeProviderRunInput({
    providerId,
    conversationId: `mcp-${providerId}-${label}`,
    runId: `run-${providerId}-${label}`,
    turnId: `turn-${providerId}-${label}`,
    cwd: root,
    prompt: "Use the tracker",
    interactionMode: "build",
    access: "supervised",
    initiativeMcpServers: plan(),
    ...overrides,
  });
}

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).not.toContain(HEADER_SECRET);
  expect(text).not.toContain(ENV_SECRET);
}

function readJsonLines(path: string): Array<{ method: string; params: Record<string, unknown> }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Source a fixture uses to start each stdio server as its own child, as a provider would. */
function spawnStdioServersSource(pidPath: string): string {
  return `
const startStdioServers=(list)=>{const {spawn}=require("node:child_process");const pids=[];
 for(const server of list){const child=spawn(server.command,server.args,{stdio:"ignore",env:{...process.env,...server.env}});pids.push(child.pid);}
 require("node:fs").writeFileSync(${JSON.stringify(pidPath)},JSON.stringify(pids));};
`;
}

async function expectStdioServersStopped(pidPath: string): Promise<void> {
  await waitFor("the stdio server pid file", () => existsSync(pidPath));
  const pids = JSON.parse(readFileSync(pidPath, "utf8")) as number[];
  expect(pids.length).toBeGreaterThan(0);
  childPids.push(...pids);
  await waitFor("the provider's stdio servers to stop with its process tree", () =>
    pids.every((pid) => !executableProcessExists(pid)), 10_000);
}

type CodexScenario = "complete" | "reject-start" | "hang-start" | "config-read-error" | "split" | "elicit";

/** Splits a value into `count` nearly equal pieces. */
function pieces(value: string, count: number): string[] {
  const size = Math.ceil(value.length / count);
  return Array.from({ length: count }, (_, index) => value.slice(index * size, (index + 1) * size));
}

/**
 * Assistant text and reasoning in which each secret arrives split across two
 * and three deltas, the way a provider streams tokens.
 */
const SPLIT_TEXT = [
  `Header ${pieces(HEADER_SECRET, 2)[0]}`, `${pieces(HEADER_SECRET, 2)[1]} and env `,
  ...pieces(ENV_SECRET, 3).map((piece, index) => index === 2 ? `${piece}.` : piece),
];
const SPLIT_REASONING = [
  `Checking ${pieces(ENV_SECRET, 2)[0]}`, `${pieces(ENV_SECRET, 2)[1]} then `,
  ...pieces(HEADER_SECRET, 3).map((piece, index) => index === 2 ? `${piece}.` : piece),
];

/** The streamed text, reasoning and result never hold a secret, and show where one was. */
function expectSplitSecretsRedacted(events: unknown[], result: ProviderRunResult): void {
  const streamed = (type: string) => (events as Array<{ type: string; text?: string }>)
    .filter((event) => event.type === type).map((event) => event.text ?? "").join("");
  expect(streamed("text")).toBe("Header [secret] and env [secret].");
  expect(streamed("reasoning-summary")).toContain("Checking [secret] then [secret].");
  expectNoSecrets(events);
  expectNoSecrets(result);
  // Not even a sizeable piece of either secret reaches an event.
  for (const secret of [HEADER_SECRET, ENV_SECRET]) {
    for (const piece of [...pieces(secret, 2), ...pieces(secret, 3)]) {
      expect(JSON.stringify(events)).not.toContain(piece);
    }
  }
}

function codexAppServer(root: string, scenario: CodexScenario, nativeServers: string[] = []): { command: string; capturePath: string; pidPath: string } {
  const command = portableNodeExecutable(root, `codex-${scenario}`);
  const capturePath = join(root, "codex-capture.jsonl");
  const pidPath = join(root, "codex-stdio-pids.json");
  const source = writeNodeSubcommand(root, "app-server", `
const fs=require("node:fs"),readline=require("node:readline");
const send=(message)=>process.stdout.write(JSON.stringify(message)+"\\n");
const capture=(message)=>fs.appendFileSync(${JSON.stringify(capturePath)},JSON.stringify({method:message.method,params:message.params})+"\\n");
${spawnStdioServersSource(pidPath)}
if(process.argv[2]==="--help"){process.stdout.write("Usage: codex app-server\\n");process.exit(0);}
let threadId="mcp-thread";
const finishTurn=(turnId)=>{
  send({method:"item/agentMessage/delta",params:{threadId,turnId,itemId:"answer",delta:"Used the tracker."}});
  send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",items:[],error:null}}});
};
readline.createInterface({input:process.stdin}).on("line",(line)=>{
 const message=JSON.parse(line);
 if(message.id==="elicit-1"&&!message.method){capture({method:"elicitation-response",params:message});return finishTurn("mcp-turn");}
 if(message.method==="initialize")return send({id:message.id,result:{userAgent:"mcp-fixture"}});
 if(message.method==="initialized")return;
 if(message.method==="model/list")return send({id:message.id,result:{data:[],nextCursor:null}});
 if(message.method==="account/rateLimits/read")return send({id:message.id,result:{rateLimits:null,rateLimitsByLimitId:null}});
 if(message.method==="config/read"){
  capture(message);
  ${scenario === "config-read-error" ? "return send({id:message.id,error:{code:-32601,message:\"config/read unavailable\"}});" : ""}
  const own=Object.fromEntries(${JSON.stringify(nativeServers)}.map((name)=>[name,{command:"own-"+name}]));
  return send({id:message.id,result:{config:{model:"fixture",mcp_servers:own}}});
 }
 if(message.method==="thread/start"||message.method==="thread/resume"){
  capture(message);
  const config=message.params.config||{};
  // Codex starts each stdio server itself, as a child of the App Server.
  const stdio=Object.entries(config).filter(([key,value])=>key.startsWith("mcp_servers.")&&value.command).map(([,value])=>({command:value.command,args:value.args||[],env:value.env||{}}));
  if(stdio.length)startStdioServers(stdio);
  ${scenario === "reject-start" ? "const header=Object.values(config).find((value)=>value.http_headers)?.http_headers?.Authorization;return send({id:message.id,error:{code:-32602,message:\"invalid mcp_servers.tracker: rejected \"+header}});" : ""}
  ${scenario === "hang-start" ? "return;" : ""}
  threadId=message.params.threadId||threadId;
  return send({id:message.id,result:{thread:{id:threadId},cwd:process.cwd(),model:"fixture",serviceTier:null,initialTurnsPage:null}});
 }
 if(message.method==="turn/interrupt")return send({id:message.id,result:{}});
 if(message.method==="turn/start"){
  capture(message);
  const turnId="mcp-turn";
  send({id:message.id,result:{turn:{id:turnId,status:"inProgress",items:[],error:null}}});
  send({method:"turn/started",params:{threadId,turn:{id:turnId,status:"inProgress",items:[],error:null}}});
  ${scenario === "elicit" ? "return send({id:\"elicit-1\",method:\"mcpServer/elicitation/request\",params:{threadId,turnId,serverName:\"tracker\",mode:\"form\",message:\"Enter the tracker token\",requestedSchema:{type:\"object\",properties:{token:{type:\"string\"}}},_meta:null}});" : ""}
  ${scenario === "split" ? `for(const delta of ${JSON.stringify(SPLIT_REASONING)})send({method:"item/reasoning/summaryTextDelta",params:{threadId,turnId,itemId:"think",summaryIndex:0,delta}});
  for(const delta of ${JSON.stringify(SPLIT_TEXT)})send({method:"item/agentMessage/delta",params:{threadId,turnId,itemId:"answer",delta}});
  return send({method:"turn/completed",params:{threadId,turn:{id:turnId,status:"completed",items:[],error:null}}});` : ""}
  return finishTurn(turnId);
 }
});
`);
  execFileSync(process.execPath, ["--check", source]);
  return { command, capturePath, pidPath };
}

describe("initiative MCP servers on Codex App Server", { concurrent: false }, () => {
  it("adds each server as one mcp_servers override on thread/start and thread/resume", async () => {
    for (const resume of [false, true]) {
      const root = portableFixtureRoot(`Codex initiative MCP ${resume ? "resume" : "start"}`);
      roots.push(root);
      const fixture = codexAppServer(root, "complete");
      const observed = observer();
      const result = await manager({ codex: fixture.command }).run(
        input("codex", root, `success-${resume}`, resume ? { sessionId: "mcp-thread" } : {}),
        observed.callbacks,
      );
      expect(result.status).toBe("completed");
      const messages = readJsonLines(fixture.capturePath);
      expect(messages.map(({ method }) => method)).toEqual(["config/read", resume ? "thread/resume" : "thread/start", "turn/start"]);
      expect(messages[0]!.params).toEqual({ includeLayers: false, cwd: root });
      expect(messages[1]!.params.config).toEqual({
        "mcp_servers.tracker": {
          url: "https://mcp.example.com/mcp",
          http_headers: { Authorization: `Bearer ${HEADER_SECRET}`, "X-Team": "checkout" },
        },
        "mcp_servers.docs": {
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
          env: { DOCS_TOKEN: ENV_SECRET, DOCS_REGION: "eu" },
        },
      });
      // Only the session request carries the values; the prompt never does.
      expectNoSecrets(messages[2]);
      expectNoSecrets(observed.events);
      expectNoSecrets(result);
      // The provider's stdio servers end with its process tree.
      await expectStdioServersStopped(fixture.pidPath);
    }
  });

  it("sends nothing new for chats without initiative servers", async () => {
    const root = portableFixtureRoot("Codex initiative MCP none");
    roots.push(root);
    const fixture = codexAppServer(root, "complete");
    const result = await manager({ codex: fixture.command }).run(
      input("codex", root, "none", { initiativeMcpServers: undefined }),
    );
    expect(result.status).toBe("completed");
    const messages = readJsonLines(fixture.capturePath);
    expect(messages.map(({ method }) => method)).toEqual(["thread/start", "turn/start"]);
    expect(messages[0]!.params).not.toHaveProperty("config");
  });

  it("never merges over a server the user configured in Codex, and adds none when Codex cannot say", async () => {
    const root = portableFixtureRoot("Codex initiative MCP clash");
    roots.push(root);
    const clash = codexAppServer(root, "complete", ["tracker"]);
    const observed = observer();
    expect((await manager({ codex: clash.command }).run(input("codex", root, "clash", {
      initiativeMcpServers: plan({ stdio: false }),
    }), observed.callbacks)).status).toBe("completed");
    const started = readJsonLines(clash.capturePath).find(({ method }) => method === "thread/start")!;
    expect(started.params).not.toHaveProperty("config");
    expect(observed.activities).toContain("Initiative MCP server not added · tracker");

    const otherRoot = portableFixtureRoot("Codex initiative MCP unreadable");
    roots.push(otherRoot);
    const unreadable = codexAppServer(otherRoot, "config-read-error");
    const unreadableObserved = observer();
    expect((await manager({ codex: unreadable.command }).run(
      input("codex", otherRoot, "unreadable"),
      unreadableObserved.callbacks,
    )).status).toBe("completed");
    expect(readJsonLines(unreadable.capturePath).find(({ method }) => method === "thread/start")!.params)
      .not.toHaveProperty("config");
    expect(unreadableObserved.activities).toContain("Initiative MCP servers not added");
  });

  it("fails cleanly, without the secret, when Codex rejects the server configuration", async () => {
    const root = portableFixtureRoot("Codex initiative MCP rejected");
    roots.push(root);
    const fixture = codexAppServer(root, "reject-start");
    const observed = observer();
    const result = await manager({ codex: fixture.command }).run(input("codex", root, "rejected"), observed.callbacks);
    expect(result.status).toBe("failed");
    expect(result.cleanupConfirmed).toBe(true);
    expect(JSON.stringify(result)).toContain("invalid mcp_servers.tracker");
    expectNoSecrets(result);
    expectNoSecrets(observed.events);
    await expectStdioServersStopped(fixture.pidPath);
  });

  it("settles a cancellation while Codex is still connecting its servers", async () => {
    const root = portableFixtureRoot("Codex initiative MCP cancelled");
    roots.push(root);
    const fixture = codexAppServer(root, "hang-start");
    const providers = manager({ codex: fixture.command });
    const running = providers.run(input("codex", root, "cancelled"));
    await waitFor("thread/start with the servers", () => readJsonLines(fixture.capturePath).some(({ method }) => method === "thread/start"));
    await waitFor("the stdio server", () => existsSync(fixture.pidPath));
    providers.cancel("mcp-codex-cancelled");
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.cleanupConfirmed).toBe(true);
    await expectStdioServersStopped(fixture.pidPath);
  });

  it("never lets a secret split across text or reasoning deltas reach an event or the result", async () => {
    const root = portableFixtureRoot("Codex initiative MCP split deltas");
    roots.push(root);
    const fixture = codexAppServer(root, "split");
    const observed = observer();
    const result = await manager({ codex: fixture.command }).run(input("codex", root, "split"), observed.callbacks);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Header [secret] and env [secret].");
    expectSplitSecretsRedacted(observed.events, result);
  });

  it("declines an MCP elicitation from an initiative server in Supervised", async () => {
    const root = portableFixtureRoot("Codex initiative MCP elicitation");
    roots.push(root);
    const fixture = codexAppServer(root, "elicit");
    const observed = observer();
    const result = await manager({ codex: fixture.command }).run(
      input("codex", root, "elicit", { access: "supervised" }),
      observed.callbacks,
    );
    expect(result.status).toBe("completed");
    const response = readJsonLines(fixture.capturePath).find(({ method }) => method === "elicitation-response")!;
    expect(response.params).toEqual({ id: "elicit-1", result: { action: "decline", content: null, _meta: null } });
    expect(observed.activities).toContain("MCP elicitation declined because this client cannot safely represent it");
    // Nothing was asked of the user.
    expect((observed.events as Array<{ type: string }>).some(({ type }) => type === "input" || type === "approval")).toBe(false);
  });

  it("delivers a maximal initiative configuration within Codex's protocol limits", async () => {
    const root = portableFixtureRoot("Codex initiative MCP maximal");
    roots.push(root);
    const fixture = codexAppServer(root, "complete");
    // The largest server list the preferences column admits, all of it HTTP.
    const maximal = Array.from({ length: MAX_INITIATIVE_MCP_SERVERS }, (_, index) => ({
      id: `${String(index).padStart(8, "0")}-5555-4555-8555-555555555555`,
      name: `server-${index}`,
      enabled: true,
      transport: {
        kind: "http" as const,
        url: `https://mcp${index}.example.com/${"p".repeat(1_000)}`,
        headers: Array.from({ length: 4 }, (_, header) => ({ name: `X-H${header}`, value: "v".repeat(MAX_INITIATIVE_MCP_ARG_CHARS / 2) })),
      },
    }));
    const result = await manager({ codex: fixture.command }).run(input("codex", root, "maximal", {
      initiativeMcpServers: { initiativeId: INITIATIVE, servers: initiativeMcpServersSchema.parse(maximal) },
    }));
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Used the tracker.");
    const started = readJsonLines(fixture.capturePath).find(({ method }) => method === "thread/start")!;
    expect(Object.keys(started.params.config as object)).toHaveLength(MAX_INITIATIVE_MCP_SERVERS);
  });
});

describe("initiative MCP servers on the Claude Agent SDK", { concurrent: false }, () => {
  interface ClaudeCapture {
    options?: ClaudeOptions;
    attached?: Record<string, unknown>;
    promptBeforeAttach?: boolean;
  }

  function claudeHarness(
    capture: ClaudeCapture,
    behaviour: "connect" | "fail" | "hang" = "connect",
    turn: { messages: SDKMessage[]; result: string } = { messages: [], result: "Done" },
  ) {
    return createClaudeAgentSdkHarness({
      createQuery: ({ prompt, options }) => {
        capture.options = options;
        const prompts = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
        let firstPrompt: Promise<IteratorResult<SDKUserMessage>> | null = null;
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          firstPrompt ??= prompts.next();
          await firstPrompt;
          yield* turn.messages;
          yield claudeSuccessResult(turn.result, "completed");
        })();
        const methods: Partial<Query> = {
          setMcpServers: async (attached) => {
            capture.attached = attached as Record<string, unknown>;
            firstPrompt = prompts.next();
            capture.promptBeforeAttach = await Promise.race([
              firstPrompt.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
            ]);
            if (behaviour === "hang") {
              await new Promise<never>((_resolve, reject) => {
                options?.abortController?.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
              });
            }
            const errors: Record<string, string> = behaviour === "fail"
              ? { tracker: `401 Unauthorized for Bearer ${HEADER_SECRET}` }
              : {};
            return { added: Object.keys(attached), removed: [], errors };
          },
        };
        return fixtureClaudeQuery(stream, methods);
      },
    });
  }

  it("attaches the servers over the SDK control channel before the prompt, never on the command line", async () => {
    const root = portableFixtureRoot("Claude initiative MCP");
    roots.push(root);
    const capture: ClaudeCapture = {};
    const observed = observer();
    const result = await manager({ claude: process.execPath }, claudeHarness(capture))
      .run(input("claude", root, "success"), { ...observed.callbacks, hostTools });
    expect(result.status).toBe("completed");
    // The query options (which the SDK turns into Claude Code's command line)
    // carry only Inertia's in-process server and no initiative value.
    expect(Object.keys(capture.options?.mcpServers ?? {})).toEqual(["inertia-chat-manager"]);
    const { mcpServers: _inProcess, abortController: _abort, ...commandLineOptions } = capture.options ?? {};
    expectNoSecrets(commandLineOptions);
    expect(capture.options?.strictMcpConfig).toBe(true);
    expect(capture.options?.settingSources).toEqual([]);
    expect(capture.options?.managedSettings).toMatchObject({
      allowedMcpServers: [{ serverName: "tracker" }, { serverName: "docs" }],
    });
    expect(Object.keys(capture.attached ?? {})).toEqual(["inertia-chat-manager", "tracker", "docs"]);
    expect(capture.attached?.tracker).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: `Bearer ${HEADER_SECRET}`, "X-Team": "checkout" },
    });
    expect(capture.attached?.docs).toMatchObject({ type: "stdio", env: { DOCS_TOKEN: ENV_SECRET, DOCS_REGION: "eu" } });
    // Claude Code starts the stdio server with its own environment: Inertia's
    // launch credentials are blanked for it.
    expectInheritedCredentialsBlanked(entries((capture.attached!.docs as { env?: Record<string, string> }).env));
    expect(capture.promptBeforeAttach).toBe(false);
    expectNoSecrets(observed.events);
    expectNoSecrets(result);
  });

  it("asks the user before an initiative server's tool runs in Supervised", async () => {
    const root = portableFixtureRoot("Claude initiative MCP permission");
    roots.push(root);
    const capture: ClaudeCapture = {};
    const approvals: string[] = [];
    const providers = manager({ claude: process.execPath }, createClaudeAgentSdkHarness({
      createQuery: ({ prompt, options }) => {
        capture.options = options;
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next();
          const decision = await options!.canUseTool!(
            "mcp__tracker__create_issue",
            { title: "Checkout" },
            {
              signal: new AbortController().signal,
              toolUseID: "tracker-call",
              requestId: "tracker-request",
              mcpServer: { name: "tracker", source: "dynamic" },
            } as never,
          );
          yield claudeSuccessResult(decision?.behavior ?? "none", "completed");
        })();
        return fixtureClaudeQuery(stream, {
          setMcpServers: async (attached) => ({ added: Object.keys(attached), removed: [], errors: {} }),
        });
      },
    }));
    const result = await providers.run(input("claude", root, "permission"), {
      hostTools,
      onApproval: (event) => {
        approvals.push(event.request.title);
        providers.respondToApproval(event.conversationId, event.request.requestId, "deny", { runId: event.runId, turnId: event.turnId });
      },
    });
    expect(result.status).toBe("completed");
    expect(approvals).toEqual(["Claude wants to use mcp__tracker__create_issue"]);
    expect(result.text).toBe("deny");
  });

  it("reports a server Claude could not connect without the secret and continues", async () => {
    const root = portableFixtureRoot("Claude initiative MCP failure");
    roots.push(root);
    const observed = observer();
    const details: string[] = [];
    const result = await manager({ claude: process.execPath }, claudeHarness({}, "fail")).run(
      input("claude", root, "failure"),
      { ...observed.callbacks, onActivity: (event) => { observed.activities.push(event.label); details.push(event.detail ?? ""); } },
    );
    expect(result.status).toBe("completed");
    expect(observed.activities).toContain("Initiative MCP server failed to connect · tracker");
    expect(details.join("\n")).toContain("401 Unauthorized");
    expectNoSecrets(details);
    expectNoSecrets(observed.events);
  });

  it("settles a cancellation while Claude connects the servers", async () => {
    const root = portableFixtureRoot("Claude initiative MCP cancelled");
    roots.push(root);
    const capture: ClaudeCapture = {};
    const providers = manager({ claude: process.execPath }, claudeHarness(capture, "hang"));
    const running = providers.run(input("claude", root, "cancelled"));
    await waitFor("setMcpServers", () => capture.attached !== undefined);
    providers.cancel("mcp-claude-cancelled");
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.cleanupConfirmed).toBe(true);
  });

  it("never lets a secret split across text or thinking deltas reach an event or the result", async () => {
    const root = portableFixtureRoot("Claude initiative MCP split deltas");
    roots.push(root);
    let frame = 0;
    const streamEvent = (event: Record<string, unknown>): SDKMessage => {
      frame += 1;
      return {
        type: "stream_event",
        uuid: `00000000-0000-4000-8000-${frame.toString(16).padStart(12, "0")}`,
        session_id: CLAUDE_PROTOCOL_SESSION_ID,
        parent_tool_use_id: null,
        event,
      } as unknown as SDKMessage;
    };
    const messages = [
      streamEvent({ type: "message_start", message: { id: "msg_split", content: [] } }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
      ...SPLIT_REASONING.map((thinking) => streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } })),
      streamEvent({ type: "content_block_stop", index: 0 }),
      streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      ...SPLIT_TEXT.map((text) => streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })),
      streamEvent({ type: "content_block_stop", index: 1 }),
    ];
    const observed = observer();
    const result = await manager({ claude: process.execPath }, claudeHarness({}, "connect", {
      messages,
      result: SPLIT_TEXT.join(""),
    })).run(input("claude", root, "split"), observed.callbacks);
    expect(result.status).toBe("completed");
    expectSplitSecretsRedacted(observed.events, result);
  });

  it("stops the stdio servers Claude Code started when its process tree ends", async () => {
    const root = portableFixtureRoot("Claude initiative MCP stdio");
    roots.push(root);
    const pidPath = join(root, "claude-stdio-pids.json");
    const capturePath = join(root, "claude-set-servers.json");
    // A Claude Code stand-in on the SDK's stdin/stdout protocol: it starts each
    // stdio server it is given as its own child, as Claude Code does.
    const executable = writeNodeClaudeExecutable(root, `
const fs=require("node:fs"),readline=require("node:readline");
const send=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");
${spawnStdioServersSource(pidPath)}
if(process.argv[2]==="--version"){process.stdout.write("2.1.200 (Claude Code)\\n");process.exit(0);}
const ok=(message,response)=>send({type:"control_response",response:{subtype:"success",request_id:message.request_id,response}});
readline.createInterface({input:process.stdin}).on("line",(line)=>{
 let message;try{message=JSON.parse(line);}catch{return;}
 if(message.type==="control_request"){
  const request=message.request;
  if(request.subtype==="initialize")return ok(message,{commands:[],models:[],agents:[],account:{}});
  if(request.subtype==="mcp_set_servers"){
   const servers=request.servers;
   fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify(servers));
   startStdioServers(Object.values(servers).filter((server)=>server.type==="stdio").map((server)=>({command:server.command,args:server.args||[],env:server.env||{}})));
   return ok(message,{added:Object.keys(servers),removed:[],errors:{}});
  }
  return ok(message,{});
 }
 if(message.type==="user"){
  send(${JSON.stringify(claudeSystem("init"))});
  send({...${JSON.stringify(claudeSuccessResult("Used the docs.", "completed"))},user_message_uuid:message.uuid});
 }
});
`);
    const observed = observer();
    const result = await manager({ claude: executable }, createClaudeAgentSdkHarness())
      .run(input("claude", root, "stdio"), observed.callbacks);
    expect(result.status).toBe("completed");
    expect(result.cleanupConfirmed).toBe(true);
    const attached = JSON.parse(readFileSync(capturePath, "utf8")) as Record<string, { type?: string; env?: Record<string, string> }>;
    expect(Object.keys(attached)).toEqual(["tracker", "docs"]);
    expectInheritedCredentialsBlanked(entries(attached.docs!.env));
    expectNoSecrets(observed.events);
    expectNoSecrets(result);
    await expectStdioServersStopped(pidPath);
  });

  it("keeps Claude runs without initiative servers exactly as before", async () => {
    const root = portableFixtureRoot("Claude initiative MCP none");
    roots.push(root);
    const capture: ClaudeCapture = {};
    const result = await manager({ claude: process.execPath }, claudeHarness(capture))
      .run(input("claude", root, "none", { initiativeMcpServers: undefined }));
    expect(result.status).toBe("completed");
    expect(capture.attached).toBeUndefined();
    expect(capture.options?.managedSettings).toMatchObject({ allowedMcpServers: [] });
    expect(capture.options?.strictMcpConfig).toBeUndefined();
  });
});

type AcpScenario = "complete" | "reject" | "hang";

function acpAgent(
  root: string,
  provider: "cursor" | "kimi",
  scenario: AcpScenario,
  supportsHttp: boolean,
  supportsResume = false,
): { command: string; capturePath: string; pidPath: string } {
  const command = portableNodeExecutable(root, `${provider}-${scenario}`);
  const capturePath = join(root, `${provider}-capture.json`);
  const pidPath = join(root, `${provider}-stdio-pids.json`);
  const source = writeNodeSubcommand(root, "acp", `
const fs=require("node:fs"),readline=require("node:readline");
const send=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");
${spawnStdioServersSource(pidPath)}
let promptId;
readline.createInterface({input:process.stdin}).on("line",(line)=>{
 const message=JSON.parse(line);
 if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,${supportsResume ? "sessionCapabilities:{resume:{}}," : ""}mcpCapabilities:{http:${String(supportsHttp)}}},agentInfo:{name:"${provider}",version:"test"}}});
 if(message.method==="session/new"||message.method==="session/load"||message.method==="session/resume"){
  const servers=message.params.mcpServers;
  fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify({method:message.method,servers}));
  const stdio=servers.filter((server)=>server.command&&server.name!=="inertia-chat-manager").map((server)=>({command:server.command,args:server.args,env:Object.fromEntries(server.env.map((entry)=>[entry.name,entry.value]))}));
  if(stdio.length)startStdioServers(stdio);
  ${scenario === "reject" ? "const header=servers.find((server)=>server.headers)?.headers?.[0]?.value;return send({jsonrpc:\"2.0\",id:message.id,error:{code:-32602,message:\"MCP server tracker rejected: \"+header}});" : ""}
  ${scenario === "hang" ? "return;" : ""}
  return send({jsonrpc:"2.0",id:message.id,result:{sessionId:"mcp-session",modes:{currentModeId:"build",availableModes:[{id:"build",name:"Build"}]},configOptions:[]}});
 }
 if(message.method==="session/prompt"){
  promptId=message.id;
  send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"mcp-session",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"Used the tracker."}}}});
  return send({jsonrpc:"2.0",id:message.id,result:{stopReason:"end_turn"}});
 }
 if(message.method==="session/cancel"&&promptId!==undefined)send({jsonrpc:"2.0",id:promptId,result:{stopReason:"cancelled"}});
});
`);
  execFileSync(process.execPath, ["--check", source]);
  return { command, capturePath, pidPath };
}

describe.each([
  { provider: "cursor" as const, harness: () => createCursorAcpHarness(), name: "Cursor" },
  { provider: "kimi" as const, harness: () => createKimiAcpHarness(), name: "Kimi Code" },
])("initiative MCP servers on $name ACP", { concurrent: false }, ({ provider, harness, name }) => {
  it("appends the servers after Inertia's own on session/new and session/load", async () => {
    for (const resume of [false, true]) {
      const root = portableFixtureRoot(`${provider} initiative MCP ${resume ? "load" : "new"}`);
      roots.push(root);
      const fixture = acpAgent(root, provider, "complete", true);
      const observed = observer();
      const result = await manager({ [provider]: fixture.command }, harness()).run(
        input(provider, root, `success-${resume}`, resume ? { sessionId: "mcp-session" } : {}),
        { ...observed.callbacks, hostTools },
      );
      expect(result.status).toBe("completed");
      const captured = JSON.parse(readFileSync(fixture.capturePath, "utf8")) as { method: string; servers: Array<Record<string, unknown>> };
      expect(captured.method).toBe(resume ? "session/load" : "session/new");
      expect(captured.servers.map((server) => server.name)).toEqual(["inertia-chat-manager", "tracker", "docs"]);
      expect(captured.servers[1]).toEqual({
        type: "http",
        name: "tracker",
        url: "https://mcp.example.com/mcp",
        headers: [{ name: "Authorization", value: `Bearer ${HEADER_SECRET}` }, { name: "X-Team", value: "checkout" }],
      });
      expect(captured.servers[2]).toEqual({
        name: "docs",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: expect.any(Array),
      });
      expectInheritedCredentialsBlanked(captured.servers[2]!.env as Array<{ name: string; value: string }>);
      expectNoSecrets(observed.events);
      expectNoSecrets(result);
      await expectStdioServersStopped(fixture.pidPath);
    }
  });

  it("leaves HTTP servers out for an agent without HTTP MCP support", async () => {
    const root = portableFixtureRoot(`${provider} initiative MCP stdio only`);
    roots.push(root);
    const fixture = acpAgent(root, provider, "complete", false);
    const observed = observer();
    const result = await manager({ [provider]: fixture.command }, harness()).run(input(provider, root, "stdio-only"), observed.callbacks);
    expect(result.status).toBe("completed");
    const captured = JSON.parse(readFileSync(fixture.capturePath, "utf8")) as { servers: Array<{ name: string }> };
    expect(captured.servers.map((server) => server.name)).toEqual(["docs"]);
    expect(observed.activities).toContain("Initiative MCP server not added · tracker");
    await expectStdioServersStopped(fixture.pidPath);
  });

  it("fails cleanly, without the secret, when the agent rejects a server", async () => {
    const root = portableFixtureRoot(`${provider} initiative MCP rejected`);
    roots.push(root);
    const fixture = acpAgent(root, provider, "reject", true);
    const observed = observer();
    const result: ProviderRunResult = await manager({ [provider]: fixture.command }, harness())
      .run(input(provider, root, "rejected"), observed.callbacks);
    expect(result.status).toBe("failed");
    expect(result.cleanupConfirmed).toBe(true);
    expectNoSecrets(result);
    expectNoSecrets(observed.events);
    await expectStdioServersStopped(fixture.pidPath);
  });

  it("settles a cancellation while the agent connects its servers", async () => {
    const root = portableFixtureRoot(`${provider} initiative MCP cancelled`);
    roots.push(root);
    const fixture = acpAgent(root, provider, "hang", true);
    const providers = manager({ [provider]: fixture.command }, harness());
    const running = providers.run(input(provider, root, "cancelled"));
    // The agent has received the servers and started its stdio server.
    await waitFor(`${name} session request`, () => existsSync(fixture.capturePath) && existsSync(fixture.pidPath));
    providers.cancel(`mcp-${provider}-cancelled`);
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.cleanupConfirmed).toBe(true);
    await expectStdioServersStopped(fixture.pidPath);
  });
});

describe("initiative MCP servers on Kimi Code session/resume", { concurrent: false }, () => {
  it("appends the servers on session/resume when the agent advertises it", async () => {
    const root = portableFixtureRoot("kimi initiative MCP resume");
    roots.push(root);
    const fixture = acpAgent(root, "kimi", "complete", true, true);
    const observed = observer();
    const result = await manager({ kimi: fixture.command }, createKimiAcpHarness()).run(
      input("kimi", root, "resume", { sessionId: "mcp-session" }),
      { ...observed.callbacks, hostTools },
    );
    expect(result.status).toBe("completed");
    const captured = JSON.parse(readFileSync(fixture.capturePath, "utf8")) as { method: string; servers: Array<Record<string, unknown>> };
    expect(captured.method).toBe("session/resume");
    expect(captured.servers.map((server) => server.name)).toEqual(["inertia-chat-manager", "tracker", "docs"]);
    expect(captured.servers[1]).toMatchObject({ type: "http", headers: [{ name: "Authorization", value: `Bearer ${HEADER_SECRET}` }, { name: "X-Team", value: "checkout" }] });
    expectInheritedCredentialsBlanked(captured.servers[2]!.env as Array<{ name: string; value: string }>);
    expectNoSecrets(observed.events);
    expectNoSecrets(result);
    await expectStdioServersStopped(fixture.pidPath);
  });
});

type OpenCodeScenario = "complete" | "fail-connect" | "slow-add" | "status-fail" | "split";

function openCodeServer(root: string, scenario: OpenCodeScenario, ownServers: string[] = []): { command: string; capturePath: string; pidPath: string } {
  const command = portableNodeExecutable(root, `opencode-${scenario}`);
  const capturePath = join(root, "opencode-capture.json");
  const pidPath = join(root, "opencode-stdio-pids.json");
  writeNodeSubcommand(root, "serve", `
const http=require("node:http"),fs=require("node:fs");
${spawnStdioServersSource(pidPath)}
const stdioServers=[];
let port=Number(process.argv.find(value=>value.startsWith("--port="))?.slice(7));
const captured=[];let events;const sessionID="mcp-session";
const save=()=>fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify({captured}));
const json=(res,value,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(status===204?undefined:JSON.stringify(value));};
const session={id:sessionID,slug:"fixture",projectID:"project",directory:${JSON.stringify(root)},title:"Fixture",version:"1.18.18",model:{id:"model-a",providerID:"fake"},time:{created:Date.now(),updated:Date.now()}};
const model={id:"model-a",providerID:"fake",api:{id:"fake",url:"http://fake",npm:"fake"},name:"Model",capabilities:{temperature:true,reasoning:true,attachment:true,toolcall:true,input:{text:true,audio:false,image:false,video:false,pdf:false},output:{text:true,audio:false,image:false,video:false,pdf:false},interleaved:true},cost:{input:0,output:0,cache:{read:0,write:0}},limit:{context:200000,output:32000},status:"active",options:{},headers:{},release_date:"2026-01-01"};
const send=event=>events?.write("data: "+JSON.stringify(event)+"\\n\\n");
const known=new Set(${JSON.stringify(ownServers)});
const server=http.createServer((req,res)=>{const url=new URL(req.url,"http://127.0.0.1");let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{
 const parsed=body?JSON.parse(body):undefined;
 if(req.method==="GET"&&url.pathname==="/global/health")return json(res,{healthy:true,version:"1.18.18"});
 if(req.method==="GET"&&url.pathname==="/mcp"){captured.push({kind:"mcp-status"});save();${scenario === "status-fail" ? "return json(res,{name:\"UnknownError\",data:{message:\"status unavailable\"}},500);" : ""}return json(res,Object.fromEntries([...known].map(name=>[name,{status:"connected"}])));}
 if(req.method==="POST"&&url.pathname==="/mcp"){
  known.add(parsed.name);
  captured.push({kind:"mcp-add",name:parsed.name,config:parsed.config});save();
  // OpenCode starts a local server as its own child.
  if(parsed.config.type==="local"){stdioServers.push({command:parsed.config.command[0],args:parsed.config.command.slice(1),env:parsed.config.environment||{}});startStdioServers(stdioServers);}
  const status=${scenario === "fail-connect" ? "parsed.name===\"tracker\"?{status:\"failed\",error:\"401 for \"+(parsed.config.headers||{}).Authorization}:{status:\"connected\"}" : "{status:\"connected\"}"};
  ${scenario === "slow-add" ? "if(parsed.name===\"tracker\")return;" : ""}
  return json(res,{[parsed.name]:status});
 }
 const disconnect=/^\\/mcp\\/([^/]+)\\/disconnect$/.exec(url.pathname);
 if(req.method==="POST"&&disconnect){captured.push({kind:"mcp-disconnect",name:decodeURIComponent(disconnect[1])});save();return json(res,true);}
 if(req.method==="GET"&&url.pathname==="/provider")return json(res,{all:[{id:"fake",name:"Fake",source:"config",env:[],options:{},models:{"model-a":model}}],default:{fake:"model-a"},connected:["fake"]});
 if(req.method==="GET"&&url.pathname==="/agent")return json(res,[]);
 if(req.method==="POST"&&url.pathname==="/session")return json(res,session);
 if(url.pathname==="/session/"+sessionID)return json(res,session);
 if(req.method==="GET"&&url.pathname==="/event"){events=res;res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive"});return res.flushHeaders();}
 if(req.method==="POST"&&url.pathname==="/session/"+sessionID+"/prompt_async"){
  captured.push({kind:"prompt"});save();json(res,undefined,204);setTimeout(()=>{send({type:"message.updated",properties:{sessionID,info:{id:"assistant",parentID:parsed.messageID,sessionID,role:"assistant"}}});
   ${scenario === "split" ? `let reasoning="";for(const delta of ${JSON.stringify(SPLIT_REASONING)}){reasoning+=delta;send({type:"message.part.updated",properties:{sessionID,part:{id:"think",sessionID,messageID:"assistant",type:"reasoning",text:reasoning}}});}
   let text="";for(const delta of ${JSON.stringify(SPLIT_TEXT)}){text+=delta;send({type:"message.part.updated",properties:{sessionID,part:{id:"text",sessionID,messageID:"assistant",type:"text",text}}});}` : `send({type:"message.part.updated",properties:{sessionID,part:{id:"text",sessionID,messageID:"assistant",type:"text",text:"Used the tracker."}}});`}
   send({type:"session.idle",properties:{sessionID}});},10);return;
 }
 return json(res,{});
});});
server.listen(port,"127.0.0.1",()=>{port=server.address().port;console.log("opencode server listening on http://127.0.0.1:"+port);});
`);
  return { command, capturePath, pidPath };
}

describe("initiative MCP servers on OpenCode", { concurrent: false }, () => {
  function captured(path: string): Array<{ kind: string; name?: string; config?: Record<string, unknown> }> {
    return (JSON.parse(readFileSync(path, "utf8")) as { captured: Array<{ kind: string; name?: string; config?: Record<string, unknown> }> }).captured;
  }

  it("adds each server after Inertia's own, before the prompt, and disconnects them at the end", async () => {
    const root = portableFixtureRoot("OpenCode initiative MCP");
    roots.push(root);
    const fixture = openCodeServer(root, "complete");
    const observed = observer();
    const result = await manager({ opencode: fixture.command }, createOpenCodeSdkHarness())
      .run(input("opencode", root, "success"), { ...observed.callbacks, hostTools });
    expect(result.status).toBe("completed");
    const steps = captured(fixture.capturePath);
    const adds = steps.filter(({ kind }) => kind === "mcp-add");
    expect(adds.map(({ name }) => name)).toEqual(["inertia-chat-manager", "tracker", "docs"]);
    expect(adds[1]!.config).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      enabled: true,
      headers: { Authorization: `Bearer ${HEADER_SECRET}`, "X-Team": "checkout" },
      oauth: false,
      timeout: 30_000,
    });
    expect(adds[2]!.config).toEqual({
      type: "local",
      command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      environment: expect.objectContaining({ DOCS_TOKEN: ENV_SECRET, DOCS_REGION: "eu", OPENCODE_SERVER_PASSWORD: "" }),
      enabled: true,
      timeout: 30_000,
    });
    expectInheritedCredentialsBlanked(entries(adds[2]!.config!.environment as Record<string, string>));
    const kinds = steps.map(({ kind }) => kind);
    expect(kinds.lastIndexOf("mcp-add")).toBeLessThan(kinds.indexOf("prompt"));
    expect(steps.filter(({ kind }) => kind === "mcp-disconnect").map(({ name }) => name))
      .toEqual(expect.arrayContaining(["tracker", "docs"]));
    expectNoSecrets(observed.events);
    expectNoSecrets(result);
  });

  it("leaves the user's same-named server alone and reports a server that fails to connect", async () => {
    const root = portableFixtureRoot("OpenCode initiative MCP clash");
    roots.push(root);
    const fixture = openCodeServer(root, "fail-connect", ["docs"]);
    const observed = observer();
    const details: string[] = [];
    const result = await manager({ opencode: fixture.command }, createOpenCodeSdkHarness()).run(
      input("opencode", root, "clash"),
      { ...observed.callbacks, onActivity: (event) => { observed.activities.push(event.label); details.push(event.detail ?? ""); } },
    );
    expect(result.status).toBe("completed");
    expect(captured(fixture.capturePath).filter(({ kind }) => kind === "mcp-add").map(({ name }) => name)).toEqual(["tracker"]);
    expect(observed.activities).toEqual(expect.arrayContaining([
      "Initiative MCP server not added · docs",
      "Initiative MCP server failed to connect · tracker",
    ]));
    expectNoSecrets(details);
    expectNoSecrets(observed.events);
  });

  it("settles a cancellation while OpenCode connects a server", async () => {
    const root = portableFixtureRoot("OpenCode initiative MCP cancelled");
    roots.push(root);
    const fixture = openCodeServer(root, "slow-add");
    const providers = manager({ opencode: fixture.command }, createOpenCodeSdkHarness());
    const running = providers.run(input("opencode", root, "cancelled"));
    await waitFor("the slow server add", () => existsSync(fixture.capturePath)
      && captured(fixture.capturePath).some(({ kind, name }) => kind === "mcp-add" && name === "tracker"), 10_000);
    providers.cancel("mcp-opencode-cancelled");
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(result.cleanupConfirmed).toBe(true);
    expect(captured(fixture.capturePath).some(({ kind }) => kind === "prompt")).toBe(false);
  });

  it("stops the stdio servers OpenCode started when its process tree ends", async () => {
    const root = portableFixtureRoot("OpenCode initiative MCP stdio");
    roots.push(root);
    const fixture = openCodeServer(root, "complete");
    const result = await manager({ opencode: fixture.command }, createOpenCodeSdkHarness())
      .run(input("opencode", root, "stdio"));
    expect(result.status).toBe("completed");
    expect(result.cleanupConfirmed).toBe(true);
    await expectStdioServersStopped(fixture.pidPath);
  });

  it("adds none of the initiative's servers when OpenCode cannot report its own, and still runs", async () => {
    const root = portableFixtureRoot("OpenCode initiative MCP status failure");
    roots.push(root);
    const fixture = openCodeServer(root, "status-fail");
    const observed = observer();
    const result = await manager({ opencode: fixture.command }, createOpenCodeSdkHarness())
      .run(input("opencode", root, "status-fail"), observed.callbacks);
    expect(result.status).toBe("completed");
    expect(result.text).toBe("Used the tracker.");
    expect(captured(fixture.capturePath).filter(({ kind }) => kind === "mcp-add")).toEqual([]);
    expect(observed.activities).toContain("Initiative MCP servers not added");
    expectNoSecrets(observed.events);
  });

  it("never lets a secret split across text or reasoning updates reach an event or the result", async () => {
    const root = portableFixtureRoot("OpenCode initiative MCP split deltas");
    roots.push(root);
    const fixture = openCodeServer(root, "split");
    const observed = observer();
    const result = await manager({ opencode: fixture.command }, createOpenCodeSdkHarness())
      .run(input("opencode", root, "split"), observed.callbacks);
    expect(result.status).toBe("completed");
    expectSplitSecretsRedacted(observed.events, result);
  });
});
