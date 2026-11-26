// @inertia-test-suite portable
// @inertia-harness pi-rpc
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { createPiRpcHarness } from "../../src/server/provider/pi-rpc-harness";
import { piLaunchConfiguration, piNativeTools, piRpcArguments } from "../../src/server/provider/pi-launch";
import { piModels, piUsage } from "../../src/server/provider/pi-models";
import { openPiRpcConnection } from "../../src/server/provider/pi-rpc";
import * as piResources from "../../src/server/provider/pi-resources";
import { portableFixtureRoot, removePortableFixture, waitFor, writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";
import { providerCallbacksFromHarness, createProviderEmitter } from "../../src/server/provider/emitter";
import type { ProviderRunResult } from "../../src/server/provider/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity,
} from "../support/turn-controller-runtime";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(removePortableFixture)); await cleanupTurnControllerTestDirectories();
});

function fixture(body: string, options: { images?: boolean; sessionId?: string; headId?: string;
  fork?: "copy" | "same-session" | "hang" | "secret" | "existing" | "ignored" | "crash" | "metadata" | "grown"; resumeExits?: boolean } = {}) {
  const root = realpathSync(portableFixtureRoot("pi-rpc")); roots.push(root);
  const home = join(root, "pi-home"); mkdirSync(home);
  const capture = join(root, "requests.jsonl");
  const spawns = join(root, "spawns.jsonl");
  const executable = writeNodeFlagExecutable(root, "pi", `
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2); const at = (flag) => args[args.indexOf(flag) + 1];
fs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
let sessionId = ${JSON.stringify(options.sessionId ?? "f4d51282-5f59-4a8c-9bfc-fd7573ae46aa")};
let sessionFile = path.join(at("--session-dir") || ${JSON.stringify(root)}, "2026-10-29_" + sessionId + ".jsonl");
const headerOf = (file) => JSON.parse(fs.readFileSync(file, "utf8").split("\\n")[0]);
if (args.includes("--session")) { sessionFile = at("--session"); sessionId = headerOf(sessionFile).id; }
const forking = ${JSON.stringify(options.fork ?? "copy")};
let hang = false; let fileBacked = args.includes("--session");
if (fileBacked && ${JSON.stringify(options.resumeExits === true)}) process.exit(3);
if (args.includes("--fork")) {
  // Pi copies the session into a new file whose header names the launch folder.
  if (forking === "crash") process.exit(4);
  const source = at("--fork"); const lines = fs.readFileSync(source, "utf8").split("\\n");
  fileBacked = true;
  if (forking === "same-session") { sessionFile = source; sessionId = headerOf(source).id; }
  else if (forking === "existing") {
    // Answers with another session that already names this folder instead of a copy.
    sessionId = "other-session"; sessionFile = path.join(at("--session-dir"), "2026-10-29_other-session.jsonl");
  } else {
    sessionId = forking === "secret" ? "secret-for-pi-tests" : "0c6c3e1e-4f3b-4c55-9d0e-2b8c2c1f7a10";
    sessionFile = path.join(at("--session-dir"), "2026-11-18_" + sessionId + ".jsonl");
    // Like Pi's forkFrom: every parseable entry, unparseable lines skipped. "ignored": an empty session instead.
    // "metadata": opening the copy appends missing settings metadata. "grown": the original gained an entry meanwhile.
    const parseable = lines.slice(1).filter((line) => { try { JSON.parse(line); return true; } catch { return false; } });
    const extra = forking === "metadata" ? [JSON.stringify({ type: "thinking_level_change", id: "meta-1", parentId: null, thinkingLevel: "off" })]
      : forking === "grown" ? [JSON.stringify({ type: "message", id: "later-1", parentId: null, message: { role: "user" } })] : [];
    const entries = forking === "ignored" ? [] : [...parseable, ...extra];
    fs.writeFileSync(sessionFile, [JSON.stringify({ ...JSON.parse(lines[0]), id: sessionId, cwd: process.cwd() }), ...entries].join("\\n") + "\\n");
  }
  hang = forking === "hang";
}
const fileEntries = () => fs.readFileSync(sessionFile, "utf8").split("\\n").slice(1).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const model = { provider: "test", id: "model", name: "Test model", reasoning: true, input: ${JSON.stringify(options.images !== false ? ["text", "image"] : ["text"])} };
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const reply = (request, data) => emit({type: "response", id: request.id, command: request.type, success: true, data});
let streaming = false;
emit({type:"extension_ui_request", id:"ready", method:"notify", message:"inertia-ready:"+process.env.INERTIA_PI_READY});
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line); fs.appendFileSync(${JSON.stringify(capture)}, line + "\\n");
  if (request.type === "get_state") { if (hang) return; return reply(request, {sessionId, sessionFile, model, isStreaming: streaming, isCompacting:false, pendingMessageCount:0}); }
  if (request.type === "get_available_models") return reply(request, {models:[model]});
  if (request.type === "get_available_thinking_levels") return reply(request, {levels:["off","low","high"]});
  if (request.type === "get_entries" && fileBacked) { const entries = fileEntries(); return reply(request, {entries, leafId: entries.at(-1)?.id ?? null}); }
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
  return { root, home, executable, events, start, requests: () => readFileSync(capture,"utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string,unknown>),
    spawns: () => (existsSync(spawns) ? readFileSync(spawns, "utf8").trim().split("\n") : []).map((line) => JSON.parse(line) as { args: string[]; cwd: string }) };
}

/** A session file Pi recorded for `cwd`, in the harness's owned session folder. */
function sessionIn(test: ReturnType<typeof fixture>, sessionId: string, cwd: string): string {
  const sessions = join(test.home, "inertia-sessions"); mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `2026-10-29_${sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd })}\n${JSON.stringify({ type: "message", id: "entry-1", parentId: null, message: { role: "assistant" } })}\n`);
  return file;
}
const handled = `if(request.type === "prompt") reply(request,{disposition:"handled"});`;
const FORKED = "0c6c3e1e-4f3b-4c55-9d0e-2b8c2c1f7a10";
const resumeInput = (test: ReturnType<typeof fixture>, sessionId: string) => nativeProviderRunInput({ providerId: "pi", cwd: test.root,
  conversationId: "pi-chat", prompt: "Hello", access: "supervised", interactionMode: "build", sessionId });

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
    // The runtime decides whether to start a new session with the chat's history; the harness never does.
    expect(await test.start(input).result).toMatchObject({status:"failed",sessionId:"missing-session",cleanupConfirmed:true,
      failure:{sessionUnavailable:true}});
    expect(test.spawns()).toEqual([]);
  });

  it("continues a moved session from a copy made in this checkout, keeping the original", async () => {
    for (const origin of ["original-checkout", "removed-checkout"]) {
      const test = fixture(handled);
      const originCwd = join(test.root, origin);
      if (origin === "original-checkout") mkdirSync(originCwd);
      const source = sessionIn(test, "moved-session", originCwd);
      const before = readFileSync(source, "utf8");
      const result = await test.start(resumeInput(test, "moved-session")).result;
      expect(result).toMatchObject({ status: "completed", sessionId: FORKED, cleanupConfirmed: true });
      const [fork, run] = test.spawns();
      expect(fork!.cwd).toBe(test.root);
      expect(fork!.args[fork!.args.indexOf("--fork") + 1]).toBe(source);
      expect(fork!.args).toEqual(expect.arrayContaining(["--no-tools", "--no-extensions", "--no-context-files"]));
      expect(fork!.args).not.toContain("--session");
      expect(run!.args[run!.args.indexOf("--session") + 1]).toContain(FORKED);
      expect(readFileSync(source, "utf8")).toBe(before);
      const sessions = test.events.filter((event) => event.type === "session");
      expect(sessions[0]).toMatchObject({ sessionId: FORKED, forkedFrom: "moved-session" });
      expect(sessions.every((event, index) => index === 0 || !("forkedFrom" in event))).toBe(true);
    }
  });

  it("resumes a session of this checkout in place", async () => {
    const test = fixture(handled);
    const file = sessionIn(test, "local-session", test.root);
    expect(await test.start(resumeInput(test, "local-session")).result).toMatchObject({ status: "completed", sessionId: "local-session" });
    expect(test.spawns()).toHaveLength(1);
    expect(test.spawns()[0]!.args[test.spawns()[0]!.args.indexOf("--session") + 1]).toBe(file);
    expect(test.events.filter((event) => event.type === "session").some((event) => "forkedFrom" in event)).toBe(false);
  });

  it("reports a session Pi definitely did not copy as unavailable, before announcing any session", async () => {
    for (const fork of ["same-session", "existing", "ignored"] as const) {
      const test = fixture(handled, { fork });
      const source = sessionIn(test, "moved-session", join(test.root, "elsewhere"));
      // Another chat's session of this checkout, which a fork must never be mistaken for.
      const other = sessionIn(test, "other-session", test.root);
      const result = await test.start(resumeInput(test, "moved-session")).result;
      expect(result).toMatchObject({ status: "failed", sessionId: "moved-session", cleanupConfirmed: true,
        failure: { sessionUnavailable: true } });
      expect(test.spawns()).toHaveLength(1);
      expect(test.events.some((event) => event.type === "session")).toBe(false);
      expect(existsSync(source) && existsSync(other)).toBe(true);
      // A refused copy Pi created is removed; nothing else in the folder is.
      expect(existsSync(join(test.home, "inertia-sessions", `2026-11-18_${FORKED}.jsonl`))).toBe(false);
    }
  });

  it("accepts a copy of a torn original and a copy Pi completed with settings metadata, as Pi resumes them", async () => {
    for (const fork of ["copy", "metadata"] as const) {
      const test = fixture(handled, { fork });
      const source = sessionIn(test, "moved-session", join(test.root, "elsewhere"));
      // A Pi process killed mid-append leaves a torn last line; Pi skips it.
      writeFileSync(source, `${readFileSync(source, "utf8")}{"type":"message","id":"torn`);
      const result = await test.start(resumeInput(test, "moved-session")).result;
      expect(result).toMatchObject({ status: "completed", sessionId: FORKED, cleanupConfirmed: true });
      expect(test.events.find((event) => event.type === "session")).toMatchObject({ sessionId: FORKED, forkedFrom: "moved-session" });
    }
  });

  it("keeps the session when the original cannot be read within limits or grew while it was copied", async () => {
    const unreadable = fixture(handled);
    const source = sessionIn(unreadable, "moved-session", join(unreadable.root, "elsewhere"));
    writeFileSync(source, `${readFileSync(source, "utf8")}${JSON.stringify({ type: "message", parentId: null })}\n`);
    const refused = await unreadable.start(resumeInput(unreadable, "moved-session")).result;
    expect(refused).toMatchObject({ status: "failed", sessionId: "moved-session", cleanupConfirmed: true });
    expect(refused.failure?.sessionUnavailable).toBeUndefined();
    expect(unreadable.spawns()).toEqual([]);
    const grown = fixture(handled, { fork: "grown" });
    const original = sessionIn(grown, "moved-session", join(grown.root, "elsewhere"));
    const result = await grown.start(resumeInput(grown, "moved-session")).result;
    expect(result).toMatchObject({ status: "failed", sessionId: "moved-session", cleanupConfirmed: true });
    expect(result.failure?.sessionUnavailable).toBeUndefined();
    expect(readdirSync(join(grown.home, "inertia-sessions"))).toEqual([basename(original)]);
  });

  it("keeps the session after an ordinary copy failure, removing what the failed copy left", async () => {
    for (const fork of ["crash", "secret"] as const) {
      const test = fixture(handled, { fork });
      const source = sessionIn(test, "moved-session", join(test.root, "elsewhere"));
      const result = await test.start(resumeInput(test, "moved-session")).result;
      expect(result).toMatchObject({ status: "failed", sessionId: "moved-session", cleanupConfirmed: true });
      expect(result.failure?.sessionUnavailable).toBeUndefined();
      expect(test.events.some((event) => event.type === "session")).toBe(false);
      expect(JSON.stringify([result, test.events])).not.toContain("secret-for-pi-tests");
      expect(existsSync(source)).toBe(true);
      expect(readdirSync(join(test.home, "inertia-sessions"))).toEqual([basename(source)]);
    }
  });

  it("removes a copy whose run ends before announcing it", async () => {
    const test = fixture(handled, { resumeExits: true });
    const source = sessionIn(test, "moved-session", join(test.root, "elsewhere"));
    const result = await test.start(resumeInput(test, "moved-session")).result;
    expect(result).toMatchObject({ status: "failed", sessionId: "moved-session", cleanupConfirmed: true });
    expect(result.failure?.sessionUnavailable).toBeUndefined();
    expect(test.spawns()).toHaveLength(2);
    expect(readdirSync(join(test.home, "inertia-sessions"))).toEqual([basename(source)]);
  });

  it("stops a hanging fork with its process tree and reports the Stop, not an unavailable session", async () => {
    const test = fixture(handled, { fork: "hang" });
    sessionIn(test, "moved-session", join(test.root, "elsewhere"));
    const run = test.start(resumeInput(test, "moved-session"));
    await waitFor("the fork process", () => test.spawns().length === 1);
    run.cancel(false);
    const result = await run.result;
    expect(result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    expect(result.failure).toBeUndefined();
    expect(test.spawns()).toHaveLength(1);
    expect(test.events.some((event) => event.type === "session")).toBe(false);
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

  it("returns false on clean Pi steer RPC rejection without cancelling the active turn", async () => {
    const test = fixture(`if(request.type === "prompt") {streaming=true;reply(request,{disposition:"started"});}
      else if(request.type === "steer") {
        emit({type:"response",id:request.id,command:"steer",success:false,error:"not steerable right now"});
        setTimeout(() => {
          emit({type:"message_start",message:{role:"assistant"}});
          emit({type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"Still completed"}});
          emit({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[]}});
          streaming=false; emit({type:"agent_settled"});
        }, 20);
      }`);
    const run = test.start();
    await waitFor("Pi running", () => test.events.some((event) => event.type === "status" && event.status === "running"));
    if (run.extension.kind !== "pi-rpc") throw new Error("wrong extension");
    await expect(run.extension.steer!({ content: "refused follow-up", imagePaths: [] })).resolves.toBe(false);
    const result = await run.result;
    expect(result).toMatchObject({ status: "completed", text: "Still completed", cleanupConfirmed: true });
    expect(result.error).toBeUndefined();
    const commands = test.requests().map((request) => request.type);
    expect(commands).not.toContain("clear_queue");
    expect(commands).not.toContain("abort");
  });

  it("redacts, clips, and surfaces cleared Pi queued messages on abort (afb8619e1d)", async () => {
    const test = fixture(`
      if (request.type === "prompt") { streaming=true; reply(request,{disposition:"started"}); }
    `);
    // Override clear_queue via a custom fixture where clear_queue returns queued entries including a secret and long text.
    const root = realpathSync(portableFixtureRoot("pi-rpc-clear-queue")); roots.push(root);
    const home = join(root, "pi-home"); mkdirSync(home);
    const executable = writeNodeFlagExecutable(root, "pi", `
const path = require("node:path");
const args = process.argv.slice(2); const at = (flag) => args[args.indexOf(flag) + 1];
const sessionId = "f4d51282-5f59-4a8c-9bfc-fd7573ae46aa";
const sessionFile = path.join(at("--session-dir") || ${JSON.stringify(root)}, "2026-10-29_" + sessionId + ".jsonl");
const model = { provider: "test", id: "model", name: "Test model", reasoning: true, input: ["text"] };
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const reply = (request, data) => emit({type: "response", id: request.id, command: request.type, success: true, data});
let streaming = false;
emit({type:"extension_ui_request", id:"ready", method:"notify", message:"inertia-ready:"+process.env.INERTIA_PI_READY});
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") return reply(request, {sessionId, sessionFile, model, isStreaming: streaming, isCompacting:false, pendingMessageCount:0});
  if (request.type === "get_available_models") return reply(request, {models:[model]});
  if (request.type === "prompt") { streaming = true; return reply(request, {disposition:"started"}); }
  if (request.type === "clear_queue") {
    return reply(request, {
      steering: ["Check token secret-for-pi-tests now", "Long entry " + "😀".repeat(400)],
      followUp: [{ text: "Follow up task" }],
    });
  }
  if (request.type === "abort") { streaming = false; return reply(request); }
});
`);
    const events: AgentHarnessEvent[] = [];
    const run = createPiRpcHarness({ startupTimeoutMs: 2000, runTimeoutMs: 10_000 }).start({
      executable,
      environment: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_API_KEY: "secret-for-pi-tests" },
      input: nativeProviderRunInput({ providerId: "pi", cwd: root, conversationId: "pi-clear", prompt: "Hello", access: "supervised", interactionMode: "build" }),
      providerNativeToolsAvailable: true,
      callbacks: { onEvent: (event) => events.push(event) },
    });
    await waitFor("Pi running", () => events.some((event) => event.type === "status" && event.status === "running"));
    run.cancel(false);
    expect(await run.result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    const notice = events.find(
      (event): event is Extract<AgentHarnessEvent, { type: "activity" }> =>
        event.type === "activity" && event.kind === "system" && event.phase === "info" && event.label.includes("Cleared queued Pi"),
    );
    expect(notice).toBeDefined();
    expect(notice!.detail).toContain("Follow up task");
    expect(notice!.detail).not.toContain("secret-for-pi-tests");
    expect(notice!.detail).toContain("[redacted]");
    expect(notice!.detail!.length).toBeLessThanOrEqual(4_000);
    // Surrogate-safe clipping: no lone high/low surrogates in notice detail.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(notice!.detail!)).toBe(false);
    void test;
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

// T3 4ecbe5508 end to end: what the Pi harness emitted, replayed into a turn controller.
const piLine = (event: Record<string, unknown>) => `emit(${JSON.stringify(event)});`;
const piText = (type: string, extra: Record<string, unknown> = {}) =>
  piLine({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra } });
const piMessage = (...lines: string[]) => [piLine({ type: "message_start", message: { role: "assistant" } }), ...lines,
  piLine({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })].join("");
const piTool = (id: string) => piLine({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: "a.ts" } })
  + piLine({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [] } });
const piPrompt = (...lines: string[]) => `if(request.type === "prompt") { streaming=true; reply(request,{disposition:"started"});
  ${lines.join("")} streaming=false; emit({type:"agent_settled"}); }`;

async function intoRuntime(events: readonly AgentHarnessEvent[], result: ProviderRunResult) {
  const runtime = await createTurnControllerTestRuntime({}, {
    modelSelection: providerNativeModelSelection({ providerId: "pi", modelId: "provider-default" }) });
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Hello" });
  runtime.controller.start(queued.turn.id);
  const identity = turnControllerTestIdentity(runtime);
  const callbacks = providerCallbacksFromHarness(createProviderEmitter("pi", identity.conversationId,
    { onEvent: (event) => runtime.provider.emit(event) }, identity.runId, identity.turnId));
  for (const event of events) {
    callbacks.onEvent?.({ ...event, conversationId: identity.conversationId, runId: identity.runId, turnId: identity.turnId } as AgentHarnessEvent);
  }
  // What the turn showed while it streamed, before the final result could correct the open segment.
  for (const [id, flush] of runtime.scheduler.callbacks) {
    if ((runtime.scheduler.delays.get(id) ?? Infinity) < 1_000) { runtime.scheduler.clearTimeout(id); flush(); }
  }
  const assistant = () => runtime.store.snapshot().messages.filter((message) => message.turnId === queued.turn.id && message.role === "assistant");
  const streamed = assistant().map(({ content }) => content);
  runtime.provider.resolve({ status: result.status, text: result.text, textTruncated: result.textTruncated });
  await flushTurnControllerTestPromises();
  const turn = runtime.store.agentTurn(queued.turn.id);
  expect(turn.status).toBe("completed");
  const messages = assistant();
  const activities = runtime.store.conversationDetail(runtime.conversationId)!.activities.filter((activity) => activity.turnId === turn.id);
  runtime.store.close();
  return { turn, messages, streamed, activities, events: runtime.events };
}

async function piTurn(...lines: string[]) {
  const test = fixture(piPrompt(...lines));
  const result = await test.start().result;
  expect(result.status).toBe("completed");
  return { result, ...await intoRuntime(test.events, result) };
}

const before = (left: { createdAt: string }, right: { createdAt: string }) => Date.parse(left.createdAt) <= Date.parse(right.createdAt);

describe("Pi restarted content blocks through the harness and the turn controller", () => {
  it("keeps text an extension notice split off, and shows only the rest of the restarted block after it", async () => {
    const { result, messages, streamed, activities, turn } = await piTurn(piMessage(
      piText("text_start"), piText("text_delta", { delta: "Hello " }),
      piLine({ type: "extension_ui_request", id: "n-1", method: "notify", message: "Indexing" }),
      piText("text_delta", { delta: "wor" }), piText("text_start"),
      piText("text_delta", { delta: "Hello world" }), piText("text_end", { content: "Hello world" })));
    expect(result.text).toBe("Hello world");
    expect(streamed).toEqual(["Hello ", "world"]);
    expect(messages.map(({ content }) => content)).toEqual(["Hello ", "world"]);
    const notice = activities.find(({ title }) => title === "Pi extension")!;
    expect(before(messages[0]!, notice) && before(notice, messages[1]!)).toBe(true);
    expect(turn.terminalAssistantMessageId).toBe(messages[1]!.id);
  });

  it("replaces only the restarted message after a tool, keeping each message in its place", async () => {
    const { messages, streamed, activities, turn } = await piTurn(
      piMessage(piText("text_delta", { delta: "Let me read the file." })), piTool("read-1"),
      piMessage(piText("text_delta", { delta: "Abandoned" }), piText("text_start"), piText("text_delta", { delta: "Final answer" })));
    expect(streamed).toEqual(["Let me read the file.", "Final answer"]);
    expect(messages.map(({ content }) => content)).toEqual(["Let me read the file.", "Final answer"]);
    const tool = activities.find(({ title }) => title === "read")!;
    expect(before(messages[0]!, tool) && before(tool, messages[1]!)).toBe(true);
    expect(turn.terminalAssistantMessageId).toBe(messages[1]!.id);
  });

  it("keeps each of three messages its own text at the end of the turn", async () => {
    const { result, messages, turn } = await piTurn(piMessage(piText("text_delta", { delta: "A" })), piTool("t-1"),
      piMessage(piText("text_delta", { delta: "B" })), piTool("t-2"), piMessage(piText("text_delta", { delta: "C" })));
    expect(result.text).toBe("A\n\nB\n\nC");
    expect(messages.map(({ content }) => content)).toEqual(["A", "B", "C"]);
    expect(turn.terminalAssistantMessageId).toBe(messages[2]!.id);
  });

  it("drops a message the restart emptied, so text after the next tool is its own message after that tool", async () => {
    const { messages, activities, turn } = await piTurn(
      piMessage(piText("text_delta", { delta: "Abandoned" }), piText("text_start"), piText("text_end")), piTool("t-1"),
      piMessage(piText("text_delta", { delta: "Answer." })));
    expect(messages.map(({ content }) => content)).toEqual(["Answer."]);
    expect(before(activities.find(({ title }) => title === "read")!, messages[0]!)).toBe(true);
    expect(turn.terminalAssistantMessageId).toBe(messages[0]!.id);
  });

  it("never makes an emptied message the turn's terminal message", async () => {
    const { messages, turn } = await piTurn(piMessage(piText("text_delta", { delta: "Intro." })), piTool("t-1"),
      piMessage(piText("text_delta", { delta: "Abandoned" }), piText("text_start"), piText("text_end")));
    expect(messages.map(({ content }) => content)).toEqual(["Intro."]);
    expect(turn.terminalAssistantMessageId).toBe(messages[0]!.id);
  });
});
