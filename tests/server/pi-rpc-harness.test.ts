// @inertia-test-suite portable
// @inertia-harness pi-rpc
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { createPiRpcHarness } from "../../src/server/provider/pi-rpc-harness";
import { piLaunchConfiguration, piNativeTools, piRpcArguments } from "../../src/server/provider/pi-launch";
import { piModels, piUsage } from "../../src/server/provider/pi-models";
import { openPiRpcConnection } from "../../src/server/provider/pi-rpc";
import * as piResources from "../../src/server/provider/pi-resources";
import { portableFixtureRoot, removePortableFixture, waitFor, writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(removePortableFixture)); });

function fixture(body: string, options: { images?: boolean; sessionId?: string; headId?: string } = {}) {
  const root = realpathSync(portableFixtureRoot("pi-rpc")); roots.push(root);
  const home = join(root, "pi-home"); mkdirSync(home);
  const capture = join(root, "requests.jsonl");
  const executable = writeNodeFlagExecutable(root, "pi", `
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2); const at = (flag) => args[args.indexOf(flag) + 1];
const sessionId = ${JSON.stringify(options.sessionId ?? "f4d51282-5f59-4a8c-9bfc-fd7573ae46aa")};
const sessionFile = path.join(at("--session-dir") || ${JSON.stringify(root)}, "2026-10-29_" + sessionId + ".jsonl");
const model = { provider: "test", id: "model", name: "Test model", reasoning: true, input: ${JSON.stringify(options.images !== false ? ["text", "image"] : ["text"])} };
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const reply = (request, data) => emit({type: "response", id: request.id, command: request.type, success: true, data});
let streaming = false;
emit({type:"extension_ui_request", id:"ready", method:"notify", message:"inertia-ready:"+process.env.INERTIA_PI_READY});
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line); fs.appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  if (request.type === "get_state") return reply(request, {sessionId, sessionFile, model, isStreaming: streaming, isCompacting:false, pendingMessageCount:0});
  if (request.type === "get_available_models") return reply(request, {models:[model]});
  if (request.type === "get_available_thinking_levels") return reply(request, {levels:["off","low","high"]});
  if (request.type === "get_entries") return reply(request, {entries:[{type:"message",id:${JSON.stringify(options.headId ?? "entry-1")},parentId:null,message:{role:"assistant"}}],leafId:${JSON.stringify(options.headId ?? "entry-1")}});
  if (request.type === "get_session_stats") return reply(request, {tokens:{input:12,output:3,total:15},contextUsage:{tokens:13,contextWindow:32000}});
  if (["set_model","set_thinking_level","clear_queue","abort","compact"].includes(request.type)) { if(request.type === "abort") streaming=false; return reply(request); }
  ${body}
});
`);
  const events: AgentHarnessEvent[] = [];
  const start = (extra: Parameters<ReturnType<typeof createPiRpcHarness>["start"]>[0]["input"] | undefined = undefined) => createPiRpcHarness({ startupTimeoutMs: 2000, runTimeoutMs: 10_000 }).start({
    executable, environment: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_API_KEY: "secret-for-pi-tests" },
    input: extra ?? nativeProviderRunInput({providerId:"pi",cwd:root,conversationId:"pi-chat",prompt:"Hello",access:"supervised",interactionMode:"build"}),
    providerNativeToolsAvailable: true, callbacks: { onEvent: (event) => events.push(event) },
  });
  return { root, executable, events, start, requests: () => readFileSync(capture,"utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string,unknown>) };
}

describe("Pi RPC production harness", () => {
  it.each(["darwin", "linux", "win32"] as const)("selects the supported native shell tools on %s", (platform) => {
    const args = piRpcArguments(piLaunchConfiguration({}), { tools: piNativeTools(platform) });
    const tools = args[args.indexOf("--tools") + 1]!.split(",");
    expect(tools).toContain("bash");
    expect(tools.includes("powershell")).toBe(platform === "win32");
  });

  it("keeps retries alive past agent_end, redacts split credentials, and returns exact identity/context", async () => {
    const test = fixture(`if(request.type === "prompt") {
      streaming=true; reply(request,{disposition:"started"});
      emit({type:"message_start",message:{role:"assistant"}});
      emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"secret-for-"}});
      emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"pi-tests"}});
      emit({type:"message_end",message:{role:"assistant",stopReason:"error",content:[]}});
      emit({type:"agent_end"}); emit({type:"auto_retry_start"});
      setTimeout(() => { emit({type:"auto_retry_end",success:true});
        emit({type:"message_start",message:{role:"assistant"}});
        emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"Done"}});
        emit({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[]}});
        streaming=false; emit({type:"agent_settled"}); },30);
    }`);
    const result = await test.start().result;
    expect(result).toMatchObject({providerId:"pi",conversationId:"pi-chat",status:"completed",cleanupConfirmed:true});
    expect(result.text).toBe("[redacted]\n\nDone");
    expect(JSON.stringify(test.events)).not.toContain("secret-for-pi-tests");
    expect(test.events).toContainEqual(expect.objectContaining({type:"extension",event:expect.objectContaining({type:"usage",usage:expect.objectContaining({usedTokens:13,maxTokens:32000})})}));
  });

  it("routes native approval and arbitrary extension input by exact UI ID", async () => {
    const test = fixture(`if(request.type === "prompt") { streaming=true; reply(request,{disposition:"started"});
      emit({type:"extension_ui_request",id:"approval",method:"confirm",title:"Inertia tool approval:"+process.env.INERTIA_PI_READY,message:"command"});
    } else if(request.type === "extension_ui_response" && request.id === "approval") {
      emit({type:"extension_ui_request",id:"choice",method:"select",title:"Choose",options:["one","two"]});
    } else if(request.type === "extension_ui_response" && request.id === "choice") { streaming=false;emit({type:"agent_settled"}); }`);
    const run = test.start();
    await waitFor("Pi event", () => test.events.some((event) => event.type === "extension" && event.event.type === "approval"));
    expect(run.extension.kind).toBe("pi-rpc");
    if (run.extension.kind !== "pi-rpc") throw new Error("wrong extension");
    const approvalId = test.events.flatMap((event) => event.type === "extension" && event.event.type === "approval" ? [event.event.request.requestId] : [])[0]!;
    expect(run.extension.respondToApproval("pi-ui:approval", "approve")).toBe(false);
    expect(run.extension.respondToApproval(approvalId, "approve")).toBe(true);
    await waitFor("Pi event", () => test.events.some((event) => event.type === "extension" && event.event.type === "input"));
    const inputId = test.events.flatMap((event) => event.type === "extension" && event.event.type === "input" ? [event.event.request.requestId] : [])[0]!;
    expect(run.extension.respondToInput(inputId, {answer:["99"]})).toBe(false);
    expect(run.extension.respondToInput(inputId, {answer:["1"]})).toBe(true);
    expect((await run.result).status).toBe("completed");
    expect(test.requests()).toContainEqual({type:"extension_ui_response",id:"choice",value:"two"});
  });

  it("clears queued work before abort and confirms cleanup", async () => {
    const test = fixture(`if(request.type === "prompt") {streaming=true;reply(request,{disposition:"started"});}`);
    const run = test.start();
    await waitFor("Pi event", () => test.events.some((event) => event.type === "status" && event.status === "running"));
    run.cancel(false);
    expect(await run.result).toMatchObject({status:"cancelled",cleanupConfirmed:true});
    const commands = test.requests().map((request) => request.type);
    expect(commands.indexOf("clear_queue")).toBeLessThan(commands.indexOf("abort"));
  });

  it("does not silently replace missing native sessions", async () => {
    const test = fixture("");
    const input = nativeProviderRunInput({providerId:"pi",cwd:test.root,conversationId:"pi-chat",prompt:"Hello",access:"supervised",interactionMode:"build",sessionId:"missing-session"});
    expect(await test.start(input).result).toMatchObject({status:"failed",sessionId:"missing-session",cleanupConfirmed:true});
  });

  it("fails an uncorrelated response without exposing provider errors", async () => {
    const test = fixture(`if(request.type === "prompt") emit({type:"response",id:request.id,command:"steer",success:false,error:process.env.TEST_API_KEY});`);
    const result = await test.start().result;
    expect(result).toMatchObject({status:"failed",cleanupConfirmed:true});
    expect(JSON.stringify(result)).not.toContain("secret-for-pi-tests");
  });

  it("admits queued steering, preserves Unicode line separators, and publishes provider-authored boundaries", async () => {
    const test=fixture(`if(request.type === "prompt") {streaming=true;reply(request,{disposition:"started"});}
      else if(request.type === "steer") {reply(request,{disposition:"queued"});
        emit({type:"message_start",message:{role:"assistant"}});
        emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:request.message}});
        emit({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[]}});
        streaming=false;emit({type:"agent_settled"});}`);
    const run=test.start();
    await waitFor("Pi running",()=>test.events.some(event=>event.type==="status"&&event.status==="running"));
    if(run.extension.kind!=="pi-rpc")throw Error("wrong extension");
    expect(await run.extension.steer!({content:"first\u2028second\u2029third",imagePaths:[]})).toBe(true);
    expect((await run.result).text).toBe("first\u2028second\u2029third");
    expect(test.events).toContainEqual(expect.objectContaining({type:"native-boundary",phase:"settled",nativeTurnId:"entry-1",persistedHeadId:"entry-1",conversationId:"pi-chat"}));
    expect(await run.extension.steer!({content:"late",imagePaths:[]})).toBe(false);
  });

  it("uses the selected native model and exact advertised thinking level", async () => {
    const test=fixture(`if(request.type === "prompt") {reply(request,{disposition:"handled"});}`);
    const input=nativeProviderRunInput({providerId:"pi",cwd:test.root,conversationId:"pi-chat",prompt:"Hello",access:"supervised",interactionMode:"build",model:"test/model",reasoningEffort:"high"});
    expect((await test.start(input).result).status).toBe("completed");
    expect(test.requests()).toContainEqual(expect.objectContaining({type:"set_model",provider:"test",modelId:"model"}));
    expect(test.requests()).toContainEqual(expect.objectContaining({type:"set_thinking_level",level:"high"}));
  });

  it("rejects image steering for a text-only model before reading files or submitting input", async () => {
    const test = fixture(`if(request.type === "prompt") {streaming=true;reply(request,{disposition:"started"});}`, { images: false });
    const run = test.start();
    try {
      await waitFor("Pi running", () => test.events.some((event) => event.type === "status" && event.status === "running"));
      if (run.extension.kind !== "pi-rpc") throw new Error("wrong extension");
      expect(await run.extension.steer!({ content: "image follow-up", imagePaths: [join(test.root, "missing.png")] })).toBe(false);
      expect(test.requests().some((request) => request.type === "steer")).toBe(false);
    } finally { run.cancel(false); await run.result; }
  });

  it("does not queue steering after its image preparation outlives the active turn", async () => {
    const test = fixture(`if(request.type === "prompt") {streaming=true;reply(request,{disposition:"started"});
      const timer=setInterval(()=>{if(!fs.existsSync(path.join(process.cwd(),"settle")))return;clearInterval(timer);
        streaming=false;emit({type:"agent_settled"});emit({type:"extension_ui_request",method:"notify",message:"settled-fixture"});},5);
    } else if(request.type === "steer") reply(request,{disposition:"queued"});`);
    const originalImages = piResources.piImages;
    let release!: () => void; let reading = false;
    const prepared = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(piResources, "piImages").mockImplementation(async (paths, roots, signal) => {
      if (!paths.length) return await originalImages(paths, roots, signal);
      reading = true; await prepared; return [];
    });
    const run = test.start();
    try {
      await waitFor("Pi running", () => test.events.some((event) => event.type === "status" && event.status === "running"));
      if (run.extension.kind !== "pi-rpc") throw new Error("wrong extension");
      const steering = run.extension.steer!({ content: "late image", imagePaths: [join(test.root, "slow.png")] });
      await waitFor("image preparation", () => reading);
      writeFileSync(join(test.root, "settle"), "");
      await waitFor("native settlement", () => test.events.some((event) => event.type === "activity" && event.detail === "settled-fixture"));
      release(); expect(await steering).toBe(false);
      expect(await run.result).toMatchObject({ status: "completed", cleanupConfirmed: true });
      expect(test.requests().some((request) => request.type === "steer")).toBe(false);
    } finally { release(); run.cancel(true); await run.result; }
  });

  it("fails and clears queued work after an unrecognized steering acknowledgement", async () => {
    const test = fixture(`if(request.type === "prompt") {streaming=true;reply(request,{disposition:"started"});}
      else if(request.type === "steer") reply(request,{disposition:"unknown"});`);
    const run = test.start();
    try {
      await waitFor("Pi running", () => test.events.some((event) => event.type === "status" && event.status === "running"));
      if (run.extension.kind !== "pi-rpc") throw new Error("wrong extension");
      await expect(run.extension.steer!({ content: "follow-up", imagePaths: [] })).rejects.toThrow("did not confirm");
      expect(await run.result).toMatchObject({ status: "failed", cleanupConfirmed: true, error: "Pi could not confirm follow-up delivery." });
      const commands = test.requests().map((request) => request.type);
      expect(commands.indexOf("clear_queue")).toBeGreaterThan(commands.indexOf("steer"));
      expect(commands.indexOf("abort")).toBeGreaterThan(commands.indexOf("clear_queue"));
    } finally { run.cancel(true); await run.result; }
  });

  it("fails malformed UTF-8 instead of admitting replacement-character JSON", async () => {
    const test=fixture(`if(request.type === "prompt") process.stdout.write(Buffer.from([0xff,10]));`);
    expect(await test.start().result).toMatchObject({status:"failed",cleanupConfirmed:true});
  });

  it.each([
    ["an overlong protocol frame", "process.stdout.write('x'.repeat(33 * 1024 * 1024))"],
    ["excessive diagnostic output", "process.stderr.write(process.env.TEST_API_KEY.repeat(20_000))"],
  ])("stops %s and confirms owned process cleanup", async (_label, output) => {
    const test = fixture(`if(request.type === "prompt") { ${output}; }`);
    const result = await test.start().result;
    expect(result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(JSON.stringify([result, test.events])).not.toContain("secret-for-pi-tests");
  });

  it("rejects secret-bearing sessions and withholds unsafe native history anchors", async () => {
    const session = fixture("", { sessionId: "secret-for-pi-tests" });
    expect(await session.start().result).toMatchObject({ status: "failed", sessionId: undefined, cleanupConfirmed: true });
    expect(session.events.some((event) => event.type === "session")).toBe(false);
    expect(JSON.stringify(session.events)).not.toContain("secret-for-pi-tests");
    const head = fixture(`if(request.type === "prompt") reply(request,{disposition:"handled"});`, { headId: "secret-for-pi-tests" });
    expect(await head.start().result).toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(head.events).toContainEqual(expect.objectContaining({ type: "native-boundary", phase: "settled", nativeTurnId: null, persistedHeadId: null }));
    expect(JSON.stringify(head.events)).not.toContain("secret-for-pi-tests");
  });

  it("rejects unsafe configuration and advertises only model-supported thinking", () => {
    for (const args of [["--session","file"],["--api-key=secret"],["--extension","relative.js"],["--unknown"],["--provider","test"]]) {
      expect(() => piLaunchConfiguration({INERTIA_PI_ARGS:JSON.stringify(args)})).toThrow();
    }
    const models = piModels({models:[{provider:"test",id:"model",reasoning:true,thinkingLevelMap:{max:"max",high:null}}]});
    expect(models[0]!.reasoningOptions.map(({value}) => value)).toEqual(["off","minimal","low","medium","max"]);
    expect(piUsage({contextUsage:{tokens:null,contextWindow:32000}}).usedTokens).toBeNull();
  });

  it("transport times out and joins owned process cleanup", async () => {
    const test = fixture("");
    const connection = openPiRpcConnection({executable:test.executable,args:[],environment:process.env,cwd:test.root,timeoutMs:30});
    await expect(connection.request("hang")).rejects.toThrow("timed out");
    await connection.close();
  });
});
