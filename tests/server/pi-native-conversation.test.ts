// @inertia-test-suite portable
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiNativeConversationOperations, piActiveEntries } from "../../src/server/provider/pi-native-conversation";
import type { NativeConversationRequest } from "../../src/server/provider/native-conversation-operations";
import { findPiSessionFile } from "../../src/server/provider/pi-session";
import { portableFixtureRoot, removePortableFixture, writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });
function fixture(changeDuringClone = false, secretIdentity?: "session" | "head") {
  const cwd = realpathSync(portableFixtureRoot("pi-native")); roots.push(cwd);
  const home = join(cwd, "pi-home"); const sessions = join(home, "inertia-sessions"); mkdirSync(sessions, {recursive:true});
  const sourceId = "source-session"; const sourceFile = join(sessions, `2026_${sourceId}.jsonl`);
  const retainedId = secretIdentity === "head" ? "fixture-pi-native-secret" : "a1";
  const entries = [
    {type:"message",id:"u1",parentId:null,message:{role:"user"}},
    {type:"message",id:retainedId,parentId:"u1",message:{role:"assistant"}},
    {type:"message",id:"u2",parentId:retainedId,message:{role:"user"}},
    {type:"message",id:"a2",parentId:"u2",message:{role:"assistant"}},
  ];
  writeFileSync(sourceFile, [{type:"session",id:sourceId,cwd},...entries].map((row)=>JSON.stringify(row)).join("\n")+"\n");
  const executable = writeNodeFlagExecutable(cwd,"pi",`
const fs = require("node:fs"); const path=require("node:path"); const {randomUUID}=require("node:crypto");
const args=process.argv.slice(2);const at=(flag)=>args[args.indexOf(flag)+1];
const root=at("--session-dir"); const forking=args.includes("--fork");
const lines=fs.readFileSync(at(forking?"--fork":"--session"),"utf8").trim().split("\\n").map(JSON.parse);
let header=lines[0];let entries=lines.slice(1);let file=at("--session");
const persist=()=>fs.writeFileSync(file,[header,...entries].map(JSON.stringify).join("\\n")+"\\n");
const clone=()=>{header={...header,id:${secretIdentity === "session" ? JSON.stringify("fixture-pi-native-secret") : "randomUUID()"},cwd:process.cwd()};file=path.join(root,"2026_"+header.id+".jsonl");persist();};
if(forking) { ${changeDuringClone ? 'entries.push({type:"message",id:"external",parentId:entries.at(-1).id,message:{role:"assistant"}});' : ""} clone(); }
const emit=(value)=>process.stdout.write(JSON.stringify(value)+"\\n");
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
 const r=JSON.parse(line);let data;
 if(r.type==="get_state")data={sessionId:header.id,sessionFile:file,isStreaming:false,isCompacting:false,pendingMessageCount:0};
 if(r.type==="get_entries")data={entries,leafId:entries.at(-1)?.id??null};
 if(r.type==="fork"){const index=entries.findIndex(e=>e.id===r.entryId);if(index<0)throw Error("bad boundary");entries=entries.slice(0,index);clone();data={cancelled:false};}
 emit({type:"response",id:r.id,command:r.type,success:true,data});
});
`);
  const request: NativeConversationRequest = {operationId:"operation-1",kind:"fork",targetConversationId:"target-chat",
    source:{identity:{projectId:"project",conversationId:"source-chat",workspaceId:"workspace",repositoryId:"repository",providerInstanceId:"pi-instance"},nativeConversationId:sourceId,expectedHeadId:"a2"},
    boundary:{kind:"turn",nativeTurnId:retainedId}};
  const launch = {cwd,executable,environment:{...process.env,PI_CODING_AGENT_DIR:home,...(secretIdentity ? { TEST_API_KEY: "fixture-pi-native-secret" } : {})}};
  return {cwd,sourceFile,sourceId,sessions,request,launch};
}

describe("Pi native history",()=>{
  it("forks after an inclusive completed turn, preserving source bytes",async()=>{
    const f=fixture();const before=readFileSync(f.sourceFile,"utf8");
    const result=await createPiNativeConversationOperations(new Set()).execute(f.request,f.launch);
    expect(result).toMatchObject({status:"completed",effect:"native-fork",identity:f.request.source.identity,targetConversationId:"target-chat",backing:{headId:"a1",persistedHeadId:"a1"}});
    if(result.status!=="completed")throw Error("not completed");
    expect(result.backing.nativeConversationId).not.toBe(f.sourceId);
    expect(readFileSync(f.sourceFile,"utf8")).toBe(before);
    const target=await findPiSessionFile(f.sessions,result.backing.nativeConversationId,f.cwd);
    expect(readFileSync(target,"utf8")).not.toContain('"u2"');
  });
  it("uses a new backing for rollback and an explicit recipe for empty history",async()=>{
    const f=fixture();const {targetConversationId:_target,...base}=f.request as Extract<NativeConversationRequest,{kind:"fork"}>;
    const operation=createPiNativeConversationOperations(new Set());
    expect(await operation.execute({...base,kind:"rollback"},f.launch)).toMatchObject({status:"completed",effect:"native-fork",backing:{headId:"a1"}});
    expect(await operation.execute({...base,kind:"rollback",boundary:{kind:"start"}},f.launch)).toMatchObject({status:"completed",effect:"new-session",backing:{headId:null,persistedHeadId:null,continuation:{kind:"new-session"}}});
  });
  it("clones the current head into a different canonical workspace",async()=>{
    const f=fixture();const destination=join(f.cwd,"destination");mkdirSync(destination);
    const result=await createPiNativeConversationOperations(new Set()).execute({...f.request,boundary:{kind:"turn",nativeTurnId:"a2"}},
      {...f.launch,cwd:destination,sourceCwd:f.cwd});
    expect(result).toMatchObject({status:"completed",backing:{headId:"a2"}});
    if(result.status==="completed") await expect(findPiSessionFile(f.sessions,result.backing.nativeConversationId,destination)).resolves.toBeTypeOf("string");
  });
  it("rejects changed heads, active sessions, and mid-turn truncation before mutation",async()=>{
    const f=fixture();const operation=createPiNativeConversationOperations(new Set());
    expect(await operation.execute({...f.request,source:{...f.request.source,expectedHeadId:"old"}},f.launch)).toMatchObject({status:"rejected",reason:"native-head-changed"});
    expect(await createPiNativeConversationOperations(new Set([f.sourceId])).execute(f.request,f.launch)).toMatchObject({status:"rejected",reason:"conversation-busy"});
    expect(await operation.execute({...f.request,boundary:{kind:"turn",nativeTurnId:"u1"}},f.launch)).toMatchObject({status:"unsupported",reason:"boundary-is-not-a-complete-native-turn"});
  });
  it("excludes abandoned branches and rejects cycles and duplicate IDs",()=>{
    const entries=[{id:"a",parentId:null},{id:"b",parentId:"a"},{id:"abandoned",parentId:"a"}];
    expect(piActiveEntries({entries,leafId:"b"}).entries.map(row=>row.id)).toEqual(["a","b"]);
    expect(()=>piActiveEntries({entries:[...entries,entries[0]],leafId:"b"})).toThrow();
    expect(()=>piActiveEntries({entries:[{id:"a",parentId:"b"},{id:"b",parentId:"a"}],leafId:"b"})).toThrow();
  });
  it("does not accept a changed clone or a mismatched native session tree",async()=>{
    const f=fixture(true);const operation=createPiNativeConversationOperations(new Set());
    expect(await operation.execute({...f.request,source:{...f.request.source,nativeSessionId:"another-tree"}},f.launch)).toMatchObject({status:"rejected",reason:"native-session-mismatch"});
    expect(await operation.execute(f.request,f.launch)).toMatchObject({status:"failed",mutationMayHaveOccurred:true,createdNativeConversationId:expect.any(String)});
  });
  it("rejects mismatched workspaces and symlinked session references",async()=>{
    const f=fixture();const outside=join(f.cwd,"other");mkdirSync(outside);
    await expect(findPiSessionFile(f.sessions,f.sourceId,outside)).rejects.toThrow("workspace");
    if(process.platform!=="win32") {
      symlinkSync(f.sourceFile,join(f.sessions,"2026_link.jsonl"));
      await expect(findPiSessionFile(f.sessions,"link",f.cwd)).rejects.toThrow("unsafe");
    }
  });
  it.each(["session", "head"] as const)("withholds secret-bearing fork %s identities", async (kind) => {
    const f = fixture(false, kind); const before = readFileSync(f.sourceFile, "utf8");
    const result = await createPiNativeConversationOperations(new Set()).execute(f.request, f.launch);
    expect(result).toMatchObject({ status: "failed", mutationMayHaveOccurred: true });
    expect(JSON.stringify(result)).not.toContain("fixture-pi-native-secret");
    if (kind === "session") expect(result).not.toHaveProperty("createdNativeConversationId");
    expect(readFileSync(f.sourceFile, "utf8")).toBe(before);
  });
});
