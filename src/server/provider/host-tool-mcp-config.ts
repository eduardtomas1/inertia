import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpRemoteConfig } from "@opencode-ai/sdk/v2";

import {
  MAX_PROVIDER_HOST_TOOL_MCP_BODY_BYTES,
  PROVIDER_HOST_TOOL_MCP_BODY_LIMIT_MESSAGE,
  type ProviderHostToolMcpConnection,
} from "./host-tool-mcp-http";

export const INERTIA_HOST_MCP_NAME = "inertia-chat-manager";
export const INERTIA_HOST_MCP_URL_ENV = "INERTIA_HOST_MCP_URL";
export const INERTIA_HOST_MCP_TOKEN_ENV = "INERTIA_HOST_MCP_TOKEN";
const MAX_STDIO_PROXY_RESPONSE_BYTES = 6 * 1024 * 1024;
const OPENCODE_HOST_MCP_TIMEOUT_MS = 30_000;

const STDIO_PROXY_SOURCE = String.raw`
const url=process.env.INERTIA_HOST_MCP_URL;
const token=process.env.INERTIA_HOST_MCP_TOKEN;
delete process.env.INERTIA_HOST_MCP_URL;
delete process.env.INERTIA_HOST_MCP_TOKEN;
if(!url||!token)process.exit(1);
const MAX_LINE=${MAX_PROVIDER_HOST_TOOL_MCP_BODY_BYTES},MAX_QUEUE=8,MAX_RESPONSE=${MAX_STDIO_PROXY_RESPONSE_BYTES},PREFIX=4096;
const LIMIT=${JSON.stringify(PROVIDER_HOST_TOOL_MCP_BODY_LIMIT_MESSAGE)};
let pending=Buffer.alloc(0),dropped=null,queue=[],running=false;
async function pump(){
 if(running)return;running=true;
 while(queue.length){
  const line=queue.shift();
  try{
   let bytes;
   if(typeof line==="string"){
    const response=await fetch(url,{method:"POST",headers:{Authorization:"Bearer "+token,Accept:"application/json, text/event-stream","Content-Type":"application/json"},body:line});
    if(response.status===204)continue;
    bytes=Buffer.from(await response.arrayBuffer());
    if(!response.ok||bytes.length>MAX_RESPONSE)throw new Error("bridge response rejected");
   }else bytes=Buffer.from(JSON.stringify({jsonrpc:"2.0",id:line.id,error:{code:-32600,message:LIMIT}}));
   const output=Buffer.concat([bytes,Buffer.from("\n")]);
   await new Promise((resolve,reject)=>process.stdout.write(output,error=>error?reject(error):resolve()));
  }catch{process.exitCode=1;process.stdin.destroy();break;}
 }
 running=false;
}
function enqueue(item){
 if(queue.length>=MAX_QUEUE){process.exit(1);return false;}
 queue.push(item);return true;
}
function oversized(prefix){
 const id=/^\s*\{(?:\s*"(?:jsonrpc|method)"\s*:\s*"[^"\\]*"\s*,)*\s*"id"\s*:\s*(-?\d+|"[^"\\]*")/.exec(prefix.toString("utf8"));
 return !id||enqueue({id:JSON.parse(id[1])});
}
process.stdin.on("data",chunk=>{
 let data=Buffer.from(chunk);
 if(dropped){
  const end=data.indexOf(10);
  if(end<0)return;
  const prefix=dropped;dropped=null;data=data.subarray(end+1);
  if(!oversized(prefix))return;
 }
 pending=Buffer.concat([pending,data]);
 let newline;
 while((newline=pending.indexOf(10))>=0){
  const raw=pending.subarray(0,newline);pending=pending.subarray(newline+1);
  if(raw.length>MAX_LINE){if(!oversized(raw.subarray(0,PREFIX)))return;continue;}
  const line=raw.toString("utf8").trim();
  if(!line)continue;
  if(!enqueue(line))return;
 }
 if(pending.length>MAX_LINE){dropped=Buffer.from(pending.subarray(0,PREFIX));pending=Buffer.alloc(0);}
 void pump();
});
process.stdin.on("end",()=>{if(pending.length>0||dropped)process.exitCode=1;});
`;

function authorization(connection: ProviderHostToolMcpConnection): string {
  return `Bearer ${connection.bearerToken}`;
}

export function acpHostMcpServers(
  connection: ProviderHostToolMcpConnection,
  supportsHttp: boolean,
): McpServer[] {
  if (supportsHttp) {
    return [{
      type: "http",
      name: INERTIA_HOST_MCP_NAME,
      url: connection.url,
      headers: [{ name: "Authorization", value: authorization(connection) }],
    }];
  }
  return [{
    name: INERTIA_HOST_MCP_NAME,
    command: process.execPath,
    args: ["--no-warnings", "-e", STDIO_PROXY_SOURCE],
    env: [
      { name: INERTIA_HOST_MCP_URL_ENV, value: connection.url },
      { name: INERTIA_HOST_MCP_TOKEN_ENV, value: connection.bearerToken },
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
    ],
  }];
}

export function openCodeHostMcpConfig(
  connection: ProviderHostToolMcpConnection,
): McpRemoteConfig {
  return {
    type: "remote",
    url: connection.url,
    enabled: true,
    headers: { Authorization: authorization(connection) },
    oauth: false,
    timeout: OPENCODE_HOST_MCP_TIMEOUT_MS,
  };
}
