import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import type { McpRemoteConfig } from "@opencode-ai/sdk/v2";

import { chatInstruction, withoutInternalProviderInstructions } from "../runtime/turns/request-context";
import type { ProviderHostToolBridge } from "./contracts";
import { SECRET_REQUEST_WAIT_MS_BY_PROVIDER } from "../../node/agent-secrets";
import {
  MAX_PROVIDER_HOST_TOOL_MCP_BODY_BYTES,
  PROVIDER_HOST_TOOL_MCP_BODY_LIMIT_MESSAGE,
  type ProviderHostToolMcpConnection,
} from "./host-tool-mcp-http";
import {
  nodeRuntimeFileSystem,
  nodeRuntimeOnPath,
  type NodeRuntimeFileSystem,
} from "./node-runtime";

export const INERTIA_HOST_MCP_NAME = "inertia-chat-manager";
export const INERTIA_SECRET_MCP_NAME = "inertia-chat-secrets";
export const INERTIA_HOST_MCP_URL_ENV = "INERTIA_HOST_MCP_URL";
export const INERTIA_HOST_MCP_TOKEN_ENV = "INERTIA_HOST_MCP_TOKEN";
const MAX_STDIO_PROXY_RESPONSE_BYTES = 6 * 1024 * 1024;
const OPENCODE_HOST_MCP_TIMEOUT_MS = 30_000;
export const OPENCODE_SECRET_MCP_TIMEOUT_MS = SECRET_REQUEST_WAIT_MS_BY_PROVIDER.opencode + 60_000;

const STDIO_PROXY_SOURCE = String.raw`
const http=require("node:http");
const rawUrl=process.env.INERTIA_HOST_MCP_URL;
const token=process.env.INERTIA_HOST_MCP_TOKEN;
delete process.env.INERTIA_HOST_MCP_URL;
delete process.env.INERTIA_HOST_MCP_TOKEN;
if(!rawUrl||!token)process.exit(1);
const target=new URL(rawUrl);
const MAX_LINE=${MAX_PROVIDER_HOST_TOOL_MCP_BODY_BYTES},MAX_QUEUE=8,MAX_IN_FLIGHT=8,MAX_RESPONSE=${MAX_STDIO_PROXY_RESPONSE_BYTES},PREFIX=4096,SUFFIX=256;
const LIMIT=${JSON.stringify(PROVIDER_HOST_TOOL_MCP_BODY_LIMIT_MESSAGE)};
let pending=Buffer.alloc(0),dropped=null,tail=null,queue=[],inFlight=0,failed=false;
let writeChain=Promise.resolve();
const activeReqs=new Set();
function fail(){
 if(failed)return;
 failed=true;
 queue.length=0;
 process.exitCode=1;
 process.stdin.destroy();
 for(const r of activeReqs)r.destroy();
 activeReqs.clear();
}
function writeLine(bytes){
 const output=Buffer.concat([bytes,Buffer.from("\n")]);
 writeChain=writeChain.then(()=>new Promise((resolve,reject)=>process.stdout.write(output,error=>error?reject(error):resolve())));
 return writeChain;
}
function post(body){
 return new Promise((resolve,reject)=>{
  const payload=Buffer.from(body,"utf8");
  const req=http.request({
   protocol:target.protocol,
   hostname:target.hostname,
   port:target.port,
   path:target.pathname+target.search,
   method:"POST",
   agent:false,
   headers:{
    Authorization:"Bearer "+token,
    Accept:"application/json, text/event-stream",
    "Content-Type":"application/json",
    "Content-Length":payload.byteLength
   }
  },res=>{
   const chunks=[];
   let size=0,done=false;
   const finish=(err,buf)=>{
    if(done)return;done=true;
    activeReqs.delete(req);
    if(err)reject(err);else resolve(buf);
   };
   if(res.statusCode===204){
    res.resume();
    res.once("end",()=>finish(null,null));
    res.once("error",err=>finish(err));
    res.once("close",()=>{if(!res.complete)finish(new Error("bridge response aborted"));});
    return;
   }
   if(!res.statusCode||res.statusCode<200||res.statusCode>=300){
    res.resume();
    finish(new Error("bridge response rejected"));
    return;
   }
   res.on("data",chunk=>{
    size+=chunk.byteLength;
    if(size>MAX_RESPONSE){res.destroy();finish(new Error("bridge response rejected"));return;}
    chunks.push(chunk);
   });
   res.on("end",()=>finish(null,Buffer.concat(chunks,size)));
   res.on("error",err=>finish(err));
   res.on("aborted",()=>finish(new Error("bridge response aborted")));
   res.on("close",()=>{if(!res.complete)finish(new Error("bridge response aborted"));});
  });
  activeReqs.add(req);
  req.setTimeout(0);
  req.on("error",err=>{activeReqs.delete(req);reject(err);});
  req.end(payload);
 });
}
function runOne(item){
 inFlight+=1;
 (async()=>{
  let bytes;
  if(typeof item==="string"){
   bytes=await post(item);
   if(bytes===null)return;
  }else bytes=Buffer.from(JSON.stringify({jsonrpc:"2.0",id:item.id,error:{code:-32600,message:LIMIT}}));
  await writeLine(bytes);
 })().catch(()=>fail()).finally(()=>{
  inFlight-=1;
  pump();
 });
}
function pump(){
 while(!failed&&inFlight<MAX_IN_FLIGHT&&queue.length>0)runOne(queue.shift());
}
function enqueue(item){
 if(failed)return false;
 if(queue.length>=MAX_QUEUE){process.exit(1);return false;}
 queue.push(item);
 pump();
 return true;
}
function oversized(prefix,suffix){
 const id=/^\s*\{(?:\s*"(?:jsonrpc|method)"\s*:\s*"[^"\\]*"\s*,)*\s*"id"\s*:\s*(-?\d+|"[^"\\]*")/.exec(prefix.toString("utf8"))
  ||/,\s*"id"\s*:\s*(-?\d+|"[^"\\]*")\s*\}\s*$/.exec(suffix.toString("utf8"));
 return !id||enqueue({id:JSON.parse(id[1])});
}
function lastBytes(buffer){return Buffer.from(buffer.subarray(Math.max(0,buffer.length-SUFFIX)));}
process.stdin.on("data",chunk=>{
 let data=Buffer.from(chunk);
 if(dropped){
  const end=data.indexOf(10);
  tail=lastBytes(Buffer.concat([tail,end<0?data:data.subarray(0,end)]));
  if(end<0)return;
  const prefix=dropped,suffix=tail;dropped=null;tail=null;data=data.subarray(end+1);
  if(!oversized(prefix,suffix))return;
 }
 pending=Buffer.concat([pending,data]);
 let newline;
 while((newline=pending.indexOf(10))>=0){
  const raw=pending.subarray(0,newline);pending=pending.subarray(newline+1);
  if(raw.length>MAX_LINE){if(!oversized(raw.subarray(0,PREFIX),lastBytes(raw)))return;continue;}
  const line=raw.toString("utf8").trim();
  if(!line)continue;
  if(!enqueue(line))return;
 }
 if(pending.length>MAX_LINE){dropped=Buffer.from(pending.subarray(0,PREFIX));tail=lastBytes(pending);pending=Buffer.alloc(0);}
 pump();
});
process.stdin.on("end",()=>{if(pending.length>0||dropped)process.exitCode=1;});
`;

export interface HostMcpProxyRuntimeOptions {
  platform?: NodeJS.Platform;
  fileSystem?: NodeRuntimeFileSystem;
  electronExecutable?: string;
}

function authorization(connection: ProviderHostToolMcpConnection): string {
  return `Bearer ${connection.bearerToken}`;
}

export function acpHostMcpServers(
  connection: ProviderHostToolMcpConnection,
  supportsHttp: boolean,
  environment: NodeJS.ProcessEnv,
  options: HostMcpProxyRuntimeOptions = {},
): McpServer[] {
  if (supportsHttp) {
    return [{
      type: "http",
      name: INERTIA_HOST_MCP_NAME,
      url: connection.url,
      headers: [{ name: "Authorization", value: authorization(connection) }],
    }];
  }
  const command = stdioProxyRuntime(environment, options);
  if (!command) return [];
  return [{
    name: INERTIA_HOST_MCP_NAME,
    command,
    args: ["--no-warnings", "-e", STDIO_PROXY_SOURCE],
    env: [
      { name: INERTIA_HOST_MCP_URL_ENV, value: connection.url },
      { name: INERTIA_HOST_MCP_TOKEN_ENV, value: connection.bearerToken },
    ],
  }];
}

/**
 * The prompt an ACP agent receives for one turn. Without HTTP MCP support and
 * without a stdio proxy runtime, no host MCP server can be attached, so the
 * instructions that exist only because the bridge was offered are withheld
 * instead of describing tools the agent cannot call, together with the
 * `inertia-chat` line that accompanies them.
 */
export function acpPromptForHostMcp(
  prompt: string,
  bridge: ProviderHostToolBridge | undefined,
  servers: readonly McpServer[],
  conversationId?: string,
): string {
  if (!bridge || servers.length > 0) return prompt;
  return withoutInternalProviderInstructions(prompt, [
    ...bridge.instructions ?? [],
    ...(conversationId === undefined ? [] : [chatInstruction(conversationId)]),
  ]);
}

function stdioProxyRuntime(
  environment: NodeJS.ProcessEnv,
  options: HostMcpProxyRuntimeOptions,
): string | null {
  const electronExecutable = options.electronExecutable
    ?? (process.versions.electron ? process.execPath : undefined);
  if (!electronExecutable) return process.execPath;
  return nodeRuntimeOnPath(environment, {
    platform: options.platform ?? process.platform,
    fileSystem: options.fileSystem ?? nodeRuntimeFileSystem,
    electronExecutable,
  });
}

export function openCodeHostMcpConfig(
  connection: ProviderHostToolMcpConnection,
  timeout = OPENCODE_HOST_MCP_TIMEOUT_MS,
): McpRemoteConfig {
  return {
    type: "remote",
    url: connection.url,
    enabled: true,
    headers: { Authorization: authorization(connection) },
    oauth: false,
    timeout,
  };
}
