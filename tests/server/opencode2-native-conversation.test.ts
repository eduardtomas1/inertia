// @inertia-test-suite portable
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenCode2NativeConversationOperations } from "../../src/server/provider/opencode2-native-conversation";
import { readOpenCode2History } from "../../src/server/provider/opencode2-history";
import { openCode2Environment, openOwnedOpenCode2Server } from "../../src/server/provider/opencode2-server";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { loopbackPortIsOpen, portableFixtureRoot, removePortableFixture, writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });
function fixture(behavior = "") {
  const cwd = realpathSync(portableFixtureRoot("opencode2-native")); roots.push(cwd);
  const file = join(cwd, "state.json");
  const source = { info: { id: "ses_source", location: { directory: cwd } }, history: [
    { id: "msg_u1", type: "user", text: "first" },
    { id: "msg_a1", type: "assistant", time: { completed: 1 }, content: [{ type: "text", text: "first reply" }] },
    { id: "msg_i1", type: "idle", outcome: "succeeded" },
    { id: "msg_u2", type: "user", text: "second" },
    { id: "msg_a2", type: "assistant", time: { completed: 2 }, content: [] },
    { id: "msg_i2", type: "idle", outcome: "succeeded" },
  ] };
  writeFileSync(file, JSON.stringify({ sessions: { ses_source: source }, requests: [] }));
  const executable = writeNodeFlagExecutable(cwd, "opencode2", `
const http=require("node:http"),fs=require("node:fs");const file=${JSON.stringify(file)},behavior=${JSON.stringify(behavior)};
const load=()=>JSON.parse(fs.readFileSync(file,"utf8"));const save=s=>fs.writeFileSync(file,JSON.stringify(s));
if(process.argv.includes("--pure") || !process.argv.includes("--hostname=127.0.0.1") || !process.argv.includes("--port=0"))process.exit(12);
if(process.env.OPENCODE_CONFIG_PROJECT_DISABLE!=="1" || !JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).experimental.policies.some(p=>p.action==="integration.use"&&p.effect==="deny"))process.exit(13);
const server=http.createServer((req,res)=>{let body="";req.on("data",c=>body+=c);req.on("end",()=>{
 if(req.headers.authorization!=="Basic "+Buffer.from("opencode:"+process.env.OPENCODE_PASSWORD).toString("base64")){res.writeHead(401);res.end();return;}
 const s=load(),url=new URL(req.url,"http://127.0.0.1"),parts=url.pathname.split("/"),id=parts[3],item=s.sessions[id],input=body?JSON.parse(body):undefined;
 s.requests.push({method:req.method,path:req.url,body:input});res.setHeader("content-type","application/json");let result;
 if(url.pathname==="/api/info")result={version:behavior==="old"?"1.19.4":"2.0.28",pid:process.pid};
 else if(url.pathname==="/api/session/active")result={data:behavior==="busy"?{ses_source:{type:"running"}}:{}};
 else if(parts[4]==="inbox")result={data:behavior==="queued"?[{id:"msg_queued"}]:[]};
 else if(parts[4]==="message") {const from=Number(url.searchParams.get("cursor")||0),data=item.history.slice(from,from+2);result={data,cursor:from+2<item.history.length?{next:String(from+2)}:{}};if(url.searchParams.has("cursor")&&url.searchParams.has("order"))throw Error("order with cursor");}
 else if(parts[4]==="fork") {const count=input.before?item.history.findIndex(m=>m.id===input.before):item.history.length;const target={info:{id:"ses_fork",location:{...item.info.location}},history:item.history.slice(0,count).map((m,i)=>({...m,id:"msg_fork_"+i}))};if(behavior==="changed")target.history[1].content=[{type:"text",text:"changed"}];s.sessions.ses_fork=target;result={data:target.info};}
 else if(parts[4]==="move"){item.info.location.directory=input.directory;item.history.push({id:"msg_moved",type:"location-switched",location:{directory:input.directory}});}
 else if(parts[2]==="experimental"&&parts[5]==="wait"){}
 else if(parts[4]==="revert"&&parts[5]==="stage"){item.info.revert={messageID:input.messageID};result={data:item.info.revert};}
 else if(parts[4]==="revert"&&parts[5]==="commit"){if(behavior==="commit-failed"){save(s);res.writeHead(500);res.end('{}');return;}item.history=item.history.slice(0,item.history.findIndex(m=>m.id===item.info.revert.messageID));delete item.info.revert;}
 else if(item)result={data:item.info};
 else {save(s);res.writeHead(404);res.end('{}');return;}
 save(s);if(result===undefined){res.writeHead(204);res.end();}else res.end(JSON.stringify(result));
 });});
server.listen(0,"127.0.0.1",()=>{const s=load();s.port=server.address().port;s.config=process.env.OPENCODE_CONFIG_DIR;save(s);process.stdout.write("server listening on http://127.0.0.1:"+s.port+"\\n");});
`);
  const request: NativeConversationRequest = { kind: "fork", operationId: "operation", targetConversationId: "target", source: {
    identity: { projectId: "project", conversationId: "source", workspaceId: "workspace", repositoryId: null, providerInstanceId: "opencode-instance" },
    nativeConversationId: "ses_source", expectedHeadId: "msg_i2",
  }, boundary: { kind: "turn", nativeTurnId: "msg_i1" } };
  const launch = { executable, cwd, environment: { ...process.env, OPENCODE_SERVER_USERNAME: "foreign", OPENCODE_PASSWORD: "inherited-should-be-replaced" } };
  const state = () => JSON.parse(readFileSync(file, "utf8")) as { sessions: Record<string, typeof source & { info: typeof source.info & { revert?: unknown } }>; requests: { method: string; path: string; body?: unknown }[]; port: number; config: string };
  return { cwd, file, source, request, launch, state };
}

describe("OpenCode 2 native history", () => {
  it("forks after the inclusive idle boundary and returns rewritten native message identities", async () => {
    const f = fixture(); const result = await createOpenCode2NativeConversationOperations(new Set()).execute(f.request, f.launch);
    expect(result).toMatchObject({ status: "completed", effect: "native-fork", identity: f.request.source.identity,
      backing: { nativeConversationId: "ses_fork", headId: "msg_fork_2", persistedHeadId: "msg_fork_2" } });
    expect(f.state().sessions.ses_source).toEqual(f.source);
    expect(f.state().sessions.ses_fork!.history).toHaveLength(3);
    expect(f.state().requests.find((r) => r.path.endsWith("/fork"))?.body).toEqual({ before: "msg_u2" });
    expect(existsSync(f.state().config)).toBe(false); expect(await loopbackPortIsOpen(f.state().port)).toBe(false);
  });
  it("relocates only the fork, waits for idle and retains its actual physical head", async () => {
    const f = fixture(); const target = join(f.cwd, "target"); mkdirSync(target);
    expect(await createOpenCode2NativeConversationOperations(new Set()).execute(f.request, { ...f.launch, cwd: target, sourceCwd: f.cwd }))
      .toMatchObject({ status: "completed", backing: { headId: "msg_fork_2", persistedHeadId: "msg_moved" } });
    expect(f.state().sessions.ses_source!.info.location.directory).toBe(f.cwd);
    expect(f.state().sessions.ses_fork!.info.location.directory).toBe(target);
  });
  it("performs history-only rollback through the exact boundary and can retain empty history", async () => {
    for (const empty of [false, true]) {
      const f = fixture(); const request: NativeConversationRequest = { ...f.request, kind: "rollback", boundary: empty ? { kind: "start" } : f.request.boundary };
      expect(await createOpenCode2NativeConversationOperations(new Set()).execute(request, f.launch)).toMatchObject({ status: "completed", effect: "native-revert", backing: { headId: empty ? null : "msg_i1" } });
      expect(f.state().sessions.ses_source!.history).toHaveLength(empty ? 0 : 3);
      expect(f.state().requests.find((r) => r.path.endsWith("/stage"))?.body).toEqual({ messageID: empty ? "msg_u1" : "msg_u2", files: false });
    }
  });
  it("rejects active or queued work, stale heads and incomplete boundaries before mutation", async () => {
    for (const mode of ["busy", "queued", "stale", "partial"]) {
      const f = fixture(mode);
      const request = mode === "stale" ? { ...f.request, source: { ...f.request.source, expectedHeadId: "msg_old" } }
        : mode === "partial" ? { ...f.request, boundary: { kind: "turn" as const, nativeTurnId: "msg_u1" } } : f.request;
      expect(await createOpenCode2NativeConversationOperations(new Set()).execute(request, f.launch)).toMatchObject({ status: mode === "partial" ? "unsupported" : "rejected" });
      expect(f.state().requests.every((r) => r.method === "GET")).toBe(true);
    }
  });
  it("preserves uncertainty after a changed fork or failed staged revert", async () => {
    const changed = fixture("changed");
    expect(await createOpenCode2NativeConversationOperations(new Set()).execute(changed.request, changed.launch))
      .toMatchObject({ status: "failed", mutationMayHaveOccurred: true, createdNativeConversationId: "ses_fork" });
    const failed = fixture("commit-failed");
    expect(await createOpenCode2NativeConversationOperations(new Set()).execute({ ...failed.request, kind: "rollback" }, failed.launch))
      .toMatchObject({ status: "failed", mutationMayHaveOccurred: true });
    expect(failed.state().sessions.ses_source!.info.revert).toEqual({ messageID: "msg_u2" });
  });
  it("rejects old server identities and strips inherited server/config control variables", async () => {
    const f = fixture("old"); await expect(openOwnedOpenCode2Server(f.launch)).rejects.toThrow("not a verified OpenCode 2 server");
    expect(await loopbackPortIsOpen(f.state().port)).toBe(false);
    const env = openCode2Environment({ OPENCODE_PASSWORD: "old", opencode_server_username: "other", OPENCODE_CONFIG: "/untrusted", OPENCODE_SIMULATE: "1" }, "/private", "replacement-password");
    expect(env.OPENCODE_PASSWORD).toBe("replacement-password"); expect(env.OPENCODE_CONFIG).toBeUndefined(); expect(env.opencode_server_username).toBeUndefined(); expect(env.OPENCODE_SIMULATE).toBeUndefined();
  });
  it("accepts newer compaction metadata while rejecting duplicate IDs and repeated cursors", async () => {
    const compact = { id: "msg_compact", type: "compaction", status: "completed", metadata: { recent: "new native shape" } };
    expect(await readOpenCode2History({ request: async () => ({ data: [compact], cursor: {} }) }, "ses_source")).toEqual([compact]);
    await expect(readOpenCode2History({ request: async () => ({ data: [compact, compact], cursor: {} }) }, "ses_source")).rejects.toThrow("identity");
    let i = 0;
    await expect(readOpenCode2History({ request: async () => ({ data: [{ ...compact, id: `msg_${i++}` }], cursor: { next: "same" } }) }, "ses_source")).rejects.toThrow("cursor");
  });
});
