// @inertia-test-suite portable
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PI_BRIDGE_SOURCE } from "../../src/server/provider/pi-bridge-source";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
interface Tool { name: string; sourceInfo?: { path?: string; source?: string }; execute?: (...args: unknown[]) => Promise<unknown> }

async function bridge(options: {mode?:string;native?:boolean;host?:boolean;platform?:NodeJS.Platform} = {}) {
  const own = pathToFileURL(resolve("inertia-test", "bridge.mjs"));
  const env: Record<string,string> = { API_KEY:"native-secret", INERTIA_PI_READY:"nonce", INERTIA_PI_ACCESS:options.mode??"supervised",
    INERTIA_PI_NATIVE_TOOLS:options.native===false?"0":"1", INERTIA_PI_TOOL_ENV:JSON.stringify({PATH:"safe-path"}),
    INERTIA_PI_INSTRUCTIONS:"Exact application instructions",
    ...(options.host?{INERTIA_PI_MCP_URL:"http://127.0.0.1:3210/mcp",INERTIA_PI_MCP_TOKEN:"host-token"}:{}) };
  const handlers = new Map<string,Handler>();
  const tools: Tool[] = [{name:"read",sourceInfo:{source:"builtin"}},{name:"edit",sourceInfo:{source:"builtin"}}];
  let active = ["read","edit","bash",...(options.platform==="win32"?["powershell"]:[])];
  const pi = { on:(name:string,handler:Handler)=>handlers.set(name,handler),
    registerTool:(tool:Tool)=>{ const old=tools.findIndex(item=>item.name===tool.name);if(old>=0)tools.splice(old,1);tools.push({...tool,sourceInfo:{path:fileURLToPath(own),source:"temporary"}}); },
    getAllTools:()=>tools,getActiveTools:()=>active,setActiveTools:(names:string[])=>{active=names;} };
  const confirm = vi.fn(async()=>true);const notify=vi.fn();
  const context = {signal:new AbortController().signal,ui:{confirm,notify}};
  const bash=vi.fn((_cwd:string,configuration:unknown)=>({name:"bash",configuration}));
  const powershell=vi.fn((_cwd:string,configuration:unknown)=>({name:"powershell",configuration}));
  const requests: Record<string,unknown>[]=[];
  const fetcher=vi.fn(async(_url:string,init:RequestInit)=>{
    const request=JSON.parse(String(init.body)) as Record<string,unknown>;requests.push(request);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer host-token");
    return new Response(JSON.stringify({id:request.id,jsonrpc:"2.0",result:request.method==="tools/list"
      ? {tools:[{name:"echo",description:"Echo",inputSchema:{type:"object",properties:{text:{type:"string"}}}}]}
      : request.method==="tools/call" ? {content:[{type:"text",text:"host reply"}]} : {protocolVersion:"2024-11-05"}}));
  });
  // Execute our static shipped extension with fake Pi imports and a fake process,
  // proving its actual source rather than a second implementation of the bridge.
  const source=PI_BRIDGE_SOURCE.replace(/^import .+;$/gmu,"").replace("import.meta.url",JSON.stringify(own.href)).replace("export default async function","return async function");
  const factory=new Function("Type","createBashToolDefinition","createPowerShellToolDefinition","fileURLToPath","resolve","process","fetch",source) as (...args:unknown[]) => (pi:unknown)=>Promise<void>;
  await factory({Unsafe:(schema:unknown)=>schema},bash,powershell,fileURLToPath,resolve,{env,platform:options.platform??"linux",cwd:()=>"/workspace"},fetcher)(pi);
  await handlers.get("session_start")!({},context);
  return {env,handlers,tools,active:()=>active,context,bash,powershell,confirm,notify,requests};
}

describe("shipped Pi managed extension",()=>{
  it("uses a credential-free PowerShell environment and supervised approval on Windows",async()=>{
    const b=await bridge({platform:"win32"});
    expect(b.active()).toContain("powershell");
    const config=b.powershell.mock.calls[0]![1] as {spawnHook:(context:unknown)=>{env:unknown}};
    expect(config.spawnHook({env:{API_KEY:"native-secret",INERTIA_PI_MCP_TOKEN:"host-token"}}).env).toEqual({PATH:"safe-path"});
    b.confirm.mockResolvedValueOnce(false);
    expect(await b.handlers.get("tool_call")!({toolName:"powershell",input:{command:"Get-Location"}},b.context)).toMatchObject({block:true});
    expect(b.confirm).toHaveBeenCalledWith("Inertia tool approval:nonce",expect.any(String),expect.any(Object));
  });

  it("loads exact host tools, authenticates each call and strips bridge credentials from shell environments",async()=>{
    const b=await bridge({host:true});
    expect(b.active()).toContain("mcp__inertia__echo");
    const tool=b.tools.find(tool=>tool.name==="mcp__inertia__echo")!;
    expect(await tool.execute!("call-1",{text:"hello"},new AbortController().signal)).toMatchObject({content:[{type:"text",text:"host reply"}]});
    expect(b.requests.map(request=>request.method)).toEqual(["initialize","tools/list","tools/call"]);
    expect(b.env.API_KEY).toBe("native-secret");
    expect(Object.keys(b.env).some(key=>key.startsWith("INERTIA_PI_"))).toBe(false);
    const config=b.bash.mock.calls[0]![1] as {spawnHook:(context:unknown)=>{env:unknown}};
    expect(config.spawnHook({env:{API_KEY:"native-secret"}}).env).toEqual({PATH:"safe-path"});
    expect(b.notify).toHaveBeenCalledWith("inertia-ready:nonce","info");
  });
  it("enforces read-only and auto-edit modes without trusting tools that impersonate builtins",async()=>{
    const readonly=await bridge({mode:"read-only"});
    expect(await readonly.handlers.get("tool_call")!({toolName:"read",input:{}},readonly.context)).toBeUndefined();
    expect(await readonly.handlers.get("tool_call")!({toolName:"bash",input:{}},readonly.context)).toMatchObject({block:true});
    const edit=await bridge({mode:"auto-edit"});
    expect(await edit.handlers.get("tool_call")!({toolName:"edit",input:{}},edit.context)).toBeUndefined();
    edit.tools.find(tool=>tool.name==="read")!.sourceInfo={source:"temporary",path:"/user/extension.js"};
    await edit.handlers.get("tool_call")!({toolName:"read",input:{path:"file"}},edit.context);
    expect(edit.confirm).toHaveBeenCalledWith("Inertia tool approval:nonce",expect.any(String),expect.any(Object));
  });
  it("removes native tool authority when unavailable and appends exact system instructions",async()=>{
    const b=await bridge({native:false,host:true});
    expect(b.active()).toEqual(["mcp__inertia__echo"]);
    expect(await b.handlers.get("tool_call")!({toolName:"read",input:{}},b.context)).toMatchObject({block:true});
    expect(await b.handlers.get("tool_call")!({toolName:"mcp__inertia__echo",input:{}},b.context)).toBeUndefined();
    expect(await b.handlers.get("before_agent_start")!({systemPrompt:"Pi instructions"},b.context)).toEqual({systemPrompt:"Pi instructions\n\nExact application instructions"});
  });
});
