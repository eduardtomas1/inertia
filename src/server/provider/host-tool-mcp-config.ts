import type { McpServer } from "@agentclientprotocol/sdk";
import type { McpRemoteConfig } from "@opencode-ai/sdk/v2";

import type { ProviderHostToolMcpConnection } from "./host-tool-mcp-http";

export const INERTIA_HOST_MCP_NAME = "inertia-chat-manager";
export const INERTIA_HOST_MCP_URL_ENV = "INERTIA_HOST_MCP_URL";
export const INERTIA_HOST_MCP_TOKEN_ENV = "INERTIA_HOST_MCP_TOKEN";

const STDIO_PROXY_SOURCE = String.raw`
const url=process.env.INERTIA_HOST_MCP_URL;
const token=process.env.INERTIA_HOST_MCP_TOKEN;
delete process.env.INERTIA_HOST_MCP_URL;
delete process.env.INERTIA_HOST_MCP_TOKEN;
if(!url||!token)process.exit(1);
const MAX_LINE=131072,MAX_QUEUE=8,MAX_RESPONSE=65536;
let pending=Buffer.alloc(0),queue=[],running=false;
async function pump(){
 if(running)return;running=true;
 while(queue.length){
  const line=queue.shift();
  try{
   const response=await fetch(url,{method:"POST",headers:{Authorization:"Bearer "+token,Accept:"application/json, text/event-stream","Content-Type":"application/json"},body:line});
   if(response.status===204)continue;
   const bytes=Buffer.from(await response.arrayBuffer());
   if(!response.ok||bytes.length>MAX_RESPONSE)throw new Error("bridge response rejected");
   const output=Buffer.concat([bytes,Buffer.from("\n")]);
   await new Promise((resolve,reject)=>process.stdout.write(output,error=>error?reject(error):resolve()));
  }catch{process.exitCode=1;process.stdin.destroy();break;}
 }
 running=false;
}
process.stdin.on("data",chunk=>{
 pending=Buffer.concat([pending,Buffer.from(chunk)]);
 if(pending.length>MAX_LINE){process.exit(1);return;}
 let newline;
 while((newline=pending.indexOf(10))>=0){
  const line=pending.subarray(0,newline).toString("utf8").trim();pending=pending.subarray(newline+1);
  if(!line)continue;
  if(Buffer.byteLength(line,"utf8")>MAX_LINE||queue.length>=MAX_QUEUE){process.exit(1);return;}
  queue.push(line);
 }
 void pump();
});
process.stdin.on("end",()=>{if(pending.length>0)process.exitCode=1;});
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
    timeout: 10_000,
  };
}
