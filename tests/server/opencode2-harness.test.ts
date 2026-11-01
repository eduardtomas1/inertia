// @inertia-test-suite portable
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { startOpenCode2Run, type OpenCode2HarnessOptions } from "../../src/server/provider/opencode2-harness";
import { openOwnedOpenCode2Server } from "../../src/server/provider/opencode2-server";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import type { ProviderHostToolBridge, ProviderHostToolCall } from "../../src/server/provider/contracts";
import { readProviderMetadata } from "../../src/server/provider/metadata";
import { portableFixtureRoot, removePortableFixture, waitFor, writeNodeFlagExecutable, loopbackPortIsOpen } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });

function fixture(mode = "success") {
  const cwd = realpathSync(portableFixtureRoot("opencode2-harness")); roots.push(cwd);
  const capture = join(cwd, "requests.jsonl"); const address = join(cwd, "port");
  const executable = writeNodeFlagExecutable(cwd, "opencode2", `
const http=require("node:http"),fs=require("node:fs");const mode=${JSON.stringify(mode)},cwd=${JSON.stringify(cwd)};
let events,active=false,history=[],pending=[],model={providerID:"test",id:"model",name:"Test",enabled:true,variants:[{id:"high"}],capabilities:{input:["text","image"]},limit:{context:32000}},info={id:"ses_fixture",location:{directory:cwd},model};
const secret="secret-for-opencode2-test";
let mcpName,mcpConfig;
const emit=(type,data={})=>events?.write("data: "+JSON.stringify({id:"evt_"+Math.random(),type,location:{directory:cwd},data:{sessionID:info.id,...data}})+"\\n\\n");
const end=()=>{active=false;history.push({id:"msg_idle",type:"idle",outcome:"succeeded"});emit("session.execution.succeeded");};
const answer=()=>{emit("session.text.started",{assistantMessageID:"msg_answer",ordinal:0});emit("session.text.delta",{assistantMessageID:"msg_answer",ordinal:0,delta:"secret-for-"});emit("session.text.delta",{assistantMessageID:"msg_answer",ordinal:0,delta:"opencode2-test"});emit("session.text.ended",{assistantMessageID:"msg_answer",ordinal:0,text:secret});history.push({id:"msg_answer",type:"assistant",time:{completed:1},content:[{type:"text",text:secret}]});emit("session.step.ended",{assistantMessageID:"msg_answer",tokens:{input:10,output:3,reasoning:1,cache:{read:2,write:0}}});setTimeout(end,80);};
const server=http.createServer(async(req,res)=>{if(req.headers.authorization!=="Basic "+Buffer.from("opencode:"+process.env.OPENCODE_PASSWORD).toString("base64")){res.writeHead(401);res.end();return;}
let raw="";for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;const u=new URL(req.url,"http://local"),p=u.pathname;
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({method:req.method,path:p,query:u.search,body:p.startsWith("/api/experimental/mcp/")?{config:{...body?.config,headers:"[redacted]"}}:body})+"\\n");
const json=(value)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value));};const empty=()=>{res.writeHead(204);res.end();};
if(p==="/api/info")return json({version:"2.0.28",pid:process.pid});
if(p==="/api/event"){events=res;res.writeHead(200,{"content-type":"text/event-stream"});res.flushHeaders();emit("session.execution.succeeded");return;}
if(p==="/api/model")return json({data:[model]});if(p==="/api/model/default")return json({data:model});
if(p.startsWith("/api/experimental/mcp/")&&req.method==="PUT"){mcpName=p.split("/").at(-1);mcpConfig=body.config;return empty();}
if(p==="/api/mcp")return json({data:[{name:mcpName,status:{status:"connected"}}]});
if(p==="/api/session"&&req.method==="POST"){if(mode==="wrong-created")info.location.directory+="-wrong";return json({data:info});}
if(p==="/api/session/active")return json({data:active||mode==="busy"?{ses_fixture:{}}:{}});
if(p==="/api/session/ses_fixture"&&req.method==="GET")return json({data:info});
if(p.endsWith("/inbox"))return json({data:pending});
if(p.endsWith("/message"))return json({data:history,cursor:{}});
if(p.endsWith("/prompt")||p.endsWith("/compact")){
if(!events){res.writeHead(409);res.end();return;}const type=p.endsWith("/compact")?"compaction":"user";
const item={id:body.id,sessionID:info.id,type,delivery:"steer",payload:{text:body.text}};pending.push(item);json({data:mode==="wrong-receipt"?{...item,id:"msg_wrong"}:item});
if(mode==="silent")return;
if(mode==="queued"){if(!active){active=true;emit("session.execution.started");pending=pending.filter(x=>x.id!==body.id);history.push({id:body.id,type:"user",text:body.text});emit("session.inbox.delivered",{inboxID:body.id});}return;}
if(active){pending=pending.filter(x=>x.id!==body.id);history.push({id:body.id,type:"user",text:body.text});emit("session.inbox.delivered",{inboxID:body.id});if(mode==="steer-wrong")res.destroy();return;}
active=true;emit("session.execution.started");pending=[];history.push({id:body.id,type,text:body.text});emit("session.inbox.delivered",{inboxID:body.id});
if(mode==="foreign"){emit("session.inbox.enqueued",{inboxID:"msg_stranger"});return;}
if(mode==="workspace"){events.write("data: "+JSON.stringify({type:"session.text.delta",location:{directory:cwd+"-other"},data:{sessionID:info.id,assistantMessageID:"msg_bad",ordinal:0,delta:"bad"}})+"\\n\\n");return;}
if(mode==="lost"){events.end();return;}
if(mode==="permission"){emit("permission.asked",{id:"perm_test",action:"shell",resources:["test command"]});return;}
if(mode==="corrupt-history"){history=[];end();return;}
if(mode==="hold")return;
if(mode==="host"){
 const response=await fetch(mcpConfig.url,{method:"POST",headers:{...mcpConfig.headers,"Content-Type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:"native-host",method:"tools/call",params:{name:"echo",arguments:{message:"hello"}}})});
 const result=await response.json();if(result.result?.content?.[0]?.text!=="host reply")return events.end();
 const token=mcpConfig.headers.Authorization.slice(7);emit("session.text.delta",{assistantMessageID:"msg_host",ordinal:0,delta:token.slice(0,12)});emit("session.text.ended",{assistantMessageID:"msg_host",ordinal:0,text:token});end();return;
}
if(type==="compaction"){history[0]={id:body.id,type:"compaction",status:"completed",newMetadata:{future:true}};end();return;}
emit("session.text.delta",{sessionID:"ses_other",assistantMessageID:"msg_other",ordinal:0,delta:"unrelated"});answer();return;}
if(p.includes("/permission/")){empty();emit("form.created",{form:{id:"frm_test",sessionID:info.id,title:"Choose",fields:[{key:"choice",type:"string",options:[{value:"a",label:"First"},{value:"b",label:"Second"}]}]}});return;}
if(p.includes("/form/")){empty();answer();return;}
if(req.method==="DELETE"&&p.includes("/inbox/")){pending=pending.filter(x=>x.id!==p.split("/").at(-1));return empty();}
if(p.endsWith("/interrupt")){active=false;return json({interrupted:true});}
if(["PUT","DELETE","PATCH","POST"].includes(req.method))return empty();
res.writeHead(404);res.end();});
server.listen(0,"127.0.0.1",()=>{fs.writeFileSync(${JSON.stringify(address)},String(server.address().port));process.stdout.write("server listening on http://127.0.0.1:"+server.address().port+"\\n");});
`);
  const events: AgentHarnessEvent[] = [];
  const start = (overrides: Partial<Parameters<typeof startOpenCode2Run>[0]["input"]> = {}, hostTools?: ProviderHostToolBridge, dependencies?: OpenCode2HarnessOptions) => {
    const options = {
    executable, environment: { ...process.env, TEST_API_KEY: "secret-for-opencode2-test" }, providerNativeToolsAvailable: true,
    installationVersion: "2.0.28", input: nativeProviderRunInput({ providerId: "opencode", cwd, conversationId: "opencode2-chat", prompt: "Hello", access: "supervised", interactionMode: "build", ...overrides }),
    callbacks: { onEvent: (event: AgentHarnessEvent) => events.push(event) },
    hostTools,
    };
    return dependencies ? startOpenCode2Run(options, dependencies)
      : createOpenCodeSdkHarness({ runDeadlineMs: mode === "silent" ? 500 : 8_000 }).start(options);
  };
  return { cwd, executable, events, start, port: () => Number(readFileSync(address, "utf8")),
    requests: () => readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; path: string; query: string; body?: Record<string, unknown> }) };
}

describe("OpenCode 2 owned production turn", () => {
  it("waits beyond streamed text for exact persisted completion and masks split secrets", async () => {
    const f = fixture(); const run = f.start();
    const result = await run.result;
    expect(result).toMatchObject({ providerId: "opencode", conversationId: "opencode2-chat", sessionId: "ses_fixture", status: "completed", text: "[redacted]", cleanupConfirmed: true });
    expect(JSON.stringify(f.events)).not.toContain("secret-for-opencode2-test");
    expect(JSON.stringify(f.events)).not.toContain("unrelated");
    expect(f.events).toContainEqual(expect.objectContaining({ type: "native-boundary", nativeTurnId: "msg_idle", persistedHeadId: "msg_idle", phase: "settled" }));
    const requests = f.requests();
    expect(requests.findIndex((r) => r.path === "/api/event")).toBeLessThan(requests.findIndex((r) => r.path.endsWith("/prompt")));
    expect(requests.find((r) => r.path.endsWith("/environment"))?.body).not.toHaveProperty("variables.TEST_API_KEY");
    expect(requests.find((r) => r.path === "/api/session")?.body?.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
    expect(await loopbackPortIsOpen(f.port())).toBe(false);
  });
  it("uses the exact permission and form IDs and acknowledges a native answer before completion", async () => {
    const f = fixture("permission"); const run = f.start();
    if (run.extension.kind !== "opencode-sdk") throw new Error("wrong extension");
    await waitFor("native permission", () => f.events.some((event) => event.type === "extension" && event.event.type === "approval"));
    expect(run.extension.respondToApproval("opencode2-permission:other", "approve")).toBe(false);
    expect(run.extension.respondToApproval("opencode2-permission:perm_test", "approve")).toBe(true);
    await waitFor("native form", () => f.events.some((event) => event.type === "extension" && event.event.type === "input"));
    expect(run.extension.respondToInput("opencode2-form:frm_test", { choice: ["99"] })).toBe(false);
    expect(run.extension.respondToInput("opencode2-form:frm_test", { choice: ["1"] })).toBe(true);
    expect((await run.result).status).toBe("completed");
    expect(f.requests().find((r) => r.path.endsWith("/form/frm_test/reply"))?.body).toEqual({ answer: { choice: "b" } });
    expect(f.requests().find((r) => r.path.endsWith("/permission/perm_test/reply"))?.body).toEqual({ decision: "once" });
  });
  it.each(["wrong-receipt", "foreign", "workspace", "lost", "corrupt-history", "wrong-created"])("fails closed on %s", async (mode) => {
      const f = fixture(mode);
      expect(await f.start().result, mode).toMatchObject({ status: "failed", cleanupConfirmed: true });
      expect(await loopbackPortIsOpen(f.port())).toBe(false);
      expect(f.events.some((event) => event.type === "native-boundary" && event.phase === "settled")).toBe(false);
  });
  it("never interrupts an already busy resumed session or submits a new prompt", async () => {
    const f = fixture("busy");
    expect((await f.start({ sessionId: "ses_fixture" }).result).status).toBe("failed");
    expect(f.requests().every((request) => request.method === "GET")).toBe(true);
  });
  it("stops the owned server even when event-reader cancellation waits for that stop", async () => {
    const f = fixture("wrong-receipt"); let streamClosing = false; let delayedServerStop = false;
    const run = f.start({}, undefined, { runTimeoutMs: 8_000, openServer: async (options) => {
      const server = await openOwnedOpenCode2Server(options);
      let release!: () => void;
      const serverStopping = new Promise<void>((resolve) => { release = resolve; });
      const subscribe = server.client.events.bind(server.client);
      server.client.events = async (callback) => {
        const stream = await subscribe(callback);
        return { done: stream.done, close: async () => {
          streamClosing = true;
          // A regression must fail without leaving the real fixture process alive.
          const deadline = setTimeout(() => { delayedServerStop = true; release(); }, 1_000);
          try { await serverStopping; await stream.close(); } finally { clearTimeout(deadline); }
        } };
      };
      return { ...server, close: async () => { release(); await server.close(); } };
    } });
    expect(await run.result).toMatchObject({ status: "failed", cleanupConfirmed: true });
    expect(streamClosing).toBe(true); expect(delayedServerStop).toBe(false);
    expect(await loopbackPortIsOpen(f.port())).toBe(false);
  });
  it("cancels only this run's admitted queue before interrupting and joins the owned server", async () => {
    const f = fixture("queued"); const run = f.start();
    if (run.extension.kind !== "opencode-sdk") throw new Error("wrong extension");
    await waitFor("prompt admission", () => f.requests().some((r) => r.path.endsWith("/prompt")));
    expect(await run.extension.steer!({ content: "Follow up", imagePaths: [] })).toBe(true);
    run.cancel(false);
    expect(await run.result).toMatchObject({ status: "cancelled", cleanupConfirmed: true });
    const requests = f.requests(); const inputs = requests.filter((r) => r.path.endsWith("/prompt")).map((r) => r.body!.id);
    const cancelled = requests.filter((r) => r.path.includes("/inbox/")).map((r) => r.path.split("/").at(-1));
    expect(cancelled.sort()).toEqual(inputs.sort());
    expect(requests.findIndex((r) => r.path.endsWith("/interrupt"))).toBeGreaterThan(requests.findLastIndex((r) => r.path.includes("/inbox/")));
    expect(requests.find((r) => r.path.endsWith("/interrupt"))?.query).toBe("?resume=false");
    expect(await loopbackPortIsOpen(f.port())).toBe(false);
  });
  it("bounds a silent run and supports exact native compaction without a fake user prompt", async () => {
    const silent = fixture("silent"); expect(await silent.start().result).toMatchObject({ status: "failed", cleanupConfirmed: true, error: "OpenCode 2 exceeded the bounded run deadline." });
    const compact = fixture(); expect((await compact.start({ operation: { kind: "compact" } }).result).status).toBe("completed");
    expect(compact.requests().some((r) => r.path.endsWith("/compact"))).toBe(true);
    expect(compact.requests().some((r) => r.path.endsWith("/prompt"))).toBe(false);
  });
  it("connects process-local host tools under the exact application turn and redacts the temporary bearer", async () => {
    const f = fixture("host"); const calls: ProviderHostToolCall[] = [];
    const bridge: ProviderHostToolBridge = { definitions: [{ name: "echo", description: "Fixture tool", inputSchema: { type: "object" }, readOnly: true }],
      invoke: async (call) => { calls.push(call); return { success: true, text: "host reply" }; } };
    expect(await f.start({ turnId: "exact-turn" }, bridge).result).toMatchObject({ status: "completed", text: "[redacted]", cleanupConfirmed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ providerThreadId: "opencode2-chat", providerTurnId: "exact-turn", tool: "echo", arguments: { message: "hello" } });
    const config = f.requests().find((r) => r.path.startsWith("/api/experimental/mcp/"))?.body?.config as { url: string; oauth: boolean; codemode: boolean };
    expect(config).toMatchObject({ oauth: false, codemode: false });
    expect(await loopbackPortIsOpen(Number(new URL(config.url).port))).toBe(false);
    expect(f.requests().some((r) => r.path.includes("/config"))).toBe(false);
  });
  it("routes model discovery to the V2 catalog and closes its owned server", async () => {
    const f = fixture();
    expect(await readProviderMetadata("opencode", f.executable, process.env, f.cwd, ["models"], undefined, 1000, "2.0.28"))
      .toMatchObject({ models: [{ id: "test/model", isDefault: true, inputModalities: ["text", "image"], reasoningOptions: [{ value: "high" }] }] });
    expect(f.requests().every((request) => request.method === "GET")).toBe(true);
    expect(await loopbackPortIsOpen(f.port())).toBe(false);
  });
  it("rejects model discovery when the owned server differs from the attested installation", async () => {
    const f = fixture();
    await expect(readProviderMetadata("opencode", f.executable, process.env, f.cwd, ["models"], undefined, 1000, "2.0.29"))
      .rejects.toThrow("verified OpenCode 2 server");
    expect(f.requests().map((request) => request.path)).toEqual(["/api/info"]);
    expect(await loopbackPortIsOpen(f.port())).toBe(false);
  });
});
