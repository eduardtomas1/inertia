import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";
import {
  claudeSuccessResult,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

const hostTools: ProviderHostToolBridge = {
  definitions: [{
    name: "inertia_list_conversations",
    description: "List safe chats.",
    inputSchema: { type: "object", additionalProperties: false },
    inputValidator: z.object({}).strict(),
    readOnly: true,
  }],
  invoke: async () => ({ success: true, text: "{}" }),
};

function cursorAgent(
  root: string,
  capturePath: string,
  supportsHttp: boolean,
  leakPath?: string,
  echoPath?: string,
): string {
  const command = portableNodeExecutable(root, `cursor-host-${supportsHttp ? "http" : "stdio"}`);
  const subcommand = writeNodeSubcommand(root, "acp", `
const fs=require("node:fs"),readline=require("node:readline");let secretToken,secretUrl;
const send=value=>process.stdout.write(JSON.stringify(value)+"\\n");
const capture=message=>{
 const server=message.params.mcpServers[0];
 if(!server){fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify({method:message.method,count:0}));return;}
 const bearer=Array.isArray(server.env)?server.env.find(entry=>entry.name==="INERTIA_HOST_MCP_TOKEN")?.value:undefined;
 const endpoint=Array.isArray(server.env)?server.env.find(entry=>entry.name==="INERTIA_HOST_MCP_URL")?.value:undefined;
 const authorization=Array.isArray(server.headers)?server.headers.find(entry=>entry.name==="Authorization")?.value:undefined;
 const token=bearer??authorization?.replace(/^Bearer /,"");
 const url=endpoint??server.url;
 secretToken=token;secretUrl=url;
 ${(leakPath ?? echoPath) ? `fs.writeFileSync(${JSON.stringify(leakPath ?? echoPath)},JSON.stringify({token,url}));` : ""}
 ${leakPath ? `process.stderr.write("provider diagnostic "+token+" "+url+"\\n");` : ""}
 fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify({
  method:message.method,
  type:server.type??"stdio",
  name:server.name,
  urlIsLoopback:typeof server.url==="string"&&server.url.startsWith("http://127.0.0.1:"),
  hasAuthorization:Array.isArray(server.headers)&&server.headers.some(entry=>entry.name==="Authorization"&&entry.value.startsWith("Bearer ")),
  commandIsAbsolute:typeof server.command==="string"&&require("node:path").isAbsolute(server.command),
  envNames:Array.isArray(server.env)?server.env.map(entry=>entry.name).sort():[],
  argsContainCredential:Array.isArray(server.args)&&server.args.some(value=>(bearer&&value.includes(bearer))||(endpoint&&value.includes(endpoint))),
 }));
};
readline.createInterface({input:process.stdin}).on("line",line=>{
 const message=JSON.parse(line);
 if(message.method==="initialize")return send({jsonrpc:"2.0",id:message.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,mcpCapabilities:{http:${String(supportsHttp)}}},agentInfo:{name:"Cursor",version:"test"}}});
 if(message.method==="session/new"||message.method==="session/load"){
  capture(message);return send({jsonrpc:"2.0",id:message.id,result:{sessionId:"cursor-host-session",modes:{currentModeId:"build",availableModes:[{id:"build",name:"Build"}]},configOptions:[]}});
 }
 if(message.method==="session/prompt"){${echoPath ? `send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"cursor-host-session",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"safe "+secretToken+" "+secretUrl}}}});send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"cursor-host-session",update:{sessionUpdate:"tool_call",toolCallId:"secret-tool",title:"Secret echo",kind:"execute",status:"failed",rawInput:{command:"echo "+secretToken},rawOutput:secretUrl}}});` : ""}${leakPath ? "return process.exit(7);" : "return send({jsonrpc:\"2.0\",id:message.id,result:{stopReason:\"end_turn\"}});"}}
});
`);
  execFileSync(process.execPath, ["--check", subcommand]);
  return command;
}

function openCodeServer(
  root: string,
  capturePath: string,
  failAfterMcp = false,
  leakPath?: string,
  echoPath?: string,
): string {
  const command = portableNodeExecutable(root, failAfterMcp ? "opencode-host-fail" : "opencode-host");
  writeNodeSubcommand(root, "serve", `
const http=require("node:http"),fs=require("node:fs");
let port=Number(process.argv.find(value=>value.startsWith("--port="))?.slice(7));
const captured=[];let events,secretToken,secretUrl,sessionPermission;const sessionID="opencode-host-session";
const save=()=>fs.writeFileSync(${JSON.stringify(capturePath)},JSON.stringify({port,captured,sessionPermission}));
const json=(res,value,status=200)=>{res.writeHead(status,{"content-type":"application/json"});res.end(status===204?undefined:JSON.stringify(value));};
const session={id:sessionID,slug:"fixture",projectID:"project",directory:${JSON.stringify(root)},title:"Fixture",version:"1.18.18",model:{id:"model-a",providerID:"fake"},time:{created:Date.now(),updated:Date.now()}};
const model={id:"model-a",providerID:"fake",api:{id:"fake",url:"http://fake",npm:"fake"},name:"Model",capabilities:{temperature:true,reasoning:true,attachment:true,toolcall:true,input:{text:true,audio:false,image:false,video:false,pdf:false},output:{text:true,audio:false,image:false,video:false,pdf:false},interleaved:true},cost:{input:0,output:0,cache:{read:0,write:0}},limit:{context:200000,output:32000},status:"active",options:{},headers:{},release_date:"2026-01-01"};
const send=event=>events?.write("data: "+JSON.stringify(event)+"\\n\\n");
const server=http.createServer((req,res)=>{const url=new URL(req.url,"http://127.0.0.1");let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{
 const parsed=body?JSON.parse(body):undefined;
 if(req.method==="GET"&&url.pathname==="/global/health")return json(res,{healthy:true,version:"1.18.18"});
 if(req.method==="POST"&&url.pathname==="/mcp"){
 const auth=parsed?.config?.headers?.Authorization;
  secretToken=auth?.replace(/^Bearer /,"");secretUrl=parsed?.config?.url;
  ${(leakPath ?? echoPath) ? `fs.writeFileSync(${JSON.stringify(leakPath ?? echoPath)},JSON.stringify({token:secretToken,url:secretUrl}));` : ""}
  ${leakPath ? `process.stderr.write("provider diagnostic "+secretToken+" "+secretUrl+"\\n");` : ""}
  captured.push({kind:"mcp-add",name:parsed?.name,directory:url.searchParams.get("directory"),type:parsed?.config?.type,urlIsLoopback:parsed?.config?.url?.startsWith("http://127.0.0.1:"),hasAuthorization:typeof auth==="string"&&auth.startsWith("Bearer "),oauth:parsed?.config?.oauth});save();
  return json(res,{"inertia-chat-manager":{status:"connected"}});
 }
 if(req.method==="POST"&&url.pathname==="/mcp/inertia-chat-manager/disconnect"){
  captured.push({kind:"mcp-disconnect",directory:url.searchParams.get("directory")});save();return json(res,true);
 }
 if(req.method==="GET"&&url.pathname==="/provider")return ${failAfterMcp ? "json(res,{message:\"provider failed \"+secretToken+\" \"+secretUrl},500)" : "json(res,{all:[{id:\"fake\",name:\"Fake\",source:\"config\",env:[],options:{},models:{\"model-a\":model}}],default:{fake:\"model-a\"},connected:[\"fake\"]})"};
 if(req.method==="GET"&&url.pathname==="/agent")return json(res,[]);
 if(req.method==="POST"&&url.pathname==="/session"){sessionPermission=parsed?.permission;save();return json(res,session);}
 if(url.pathname==="/session/"+sessionID)return json(res,session);
 if(req.method==="GET"&&url.pathname==="/event"){events=res;res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive"});return res.flushHeaders();}
 if(req.method==="POST"&&url.pathname==="/session/"+sessionID+"/prompt_async"){
  captured.push({kind:"prompt"});save();json(res,undefined,204);setTimeout(()=>{send({type:"message.updated",properties:{sessionID,info:{id:"assistant",parentID:parsed.messageID,sessionID,role:"assistant"}}});${echoPath ? `send({type:"session.status",properties:{sessionID,status:{type:"retry",message:"retry "+secretToken+" "+secretUrl}}});` : ""}send({type:"message.part.updated",properties:{sessionID,part:{id:"text",sessionID,messageID:"assistant",type:"text",text:${echoPath ? `"Done "+secretToken+" "+secretUrl` : `"Done"`}}}});send({type:"session.idle",properties:{sessionID}});},10);return;
 }
 return json(res,{});
});});
server.listen(port,"127.0.0.1",()=>{port=server.address().port;save();console.log("opencode server listening on http://127.0.0.1:"+port);});
`);
  return command;
}

describe.sequential("provider host-tool injection", () => {
  it.each([false, true])("injects Claude's exact in-process bridge without a second SDK approval (resume=%s)", async (resume) => {
    const root = portableFixtureRoot(`Claude host tools ${resume ? "resume" : "new"}`);
    roots.push(root);
    let permission: Awaited<ReturnType<CanUseTool>> | undefined;
    let mcpServerNames: string[] = [];
    let mcpConfigKeys: string[] = [];
    let strictMcpConfig: boolean | undefined;
    const richEvents: unknown[] = [];
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: ({ options }) => {
          mcpServerNames = Object.keys(options?.mcpServers ?? {});
          mcpConfigKeys = Object.keys(
            options?.mcpServers?.["inertia-chat-manager"] ?? {},
          );
          strictMcpConfig = options?.strictMcpConfig;
          const canUseTool = options?.canUseTool;
          if (!canUseTool) throw new Error("Claude did not install its tool policy callback.");
          const stream = (async function* (): AsyncGenerator<SDKMessage> {
            permission = await canUseTool(
              "mcp__inertia-chat-manager__inertia_list_conversations",
              {},
              {
                signal: new AbortController().signal,
                toolUseID: "claude-host-tool",
                requestId: "claude-provider-request",
              },
            );
            yield claudeSuccessResult("Done", "completed");
          })();
          return fixtureClaudeQuery(stream);
        },
      })]),
    );
    const result = await manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: `claude-host-${resume}`,
      runId: "run-claude-host",
      turnId: "turn-claude-host",
      cwd: root,
      prompt: "Use chat tools",
      interactionMode: "build",
      access: "supervised",
      ...(resume ? { sessionId: "claude-existing-session" } : {}),
    }), {
      hostTools,
      onApproval: (event) => richEvents.push(event),
    });
    expect(result.status).toBe("completed");
    expect(mcpServerNames).toEqual(["inertia-chat-manager"]);
    expect(mcpConfigKeys).toEqual(expect.arrayContaining(["type", "name", "instance"]));
    expect(mcpConfigKeys).not.toEqual(expect.arrayContaining([
      "url",
      "headers",
      "env",
      "command",
      "args",
    ]));
    expect(strictMcpConfig).toBe(true);
    expect(permission).toEqual({ behavior: "allow", updatedInput: {} });
    expect(richEvents).not.toContainEqual(expect.objectContaining({ type: "approval" }));
  });

  it.each([
    { supportsHttp: true, expectedType: "http" },
    { supportsHttp: false, expectedType: "stdio" },
  ])("injects an exact Cursor $expectedType bridge on new and resumed sessions", async ({
    supportsHttp,
    expectedType,
  }) => {
    for (const resume of [false, true]) {
      const root = portableFixtureRoot(`Cursor host ${expectedType} ${resume ? "resume" : "new"}`);
      roots.push(root);
      const capturePath = join(root, "capture.json");
      const manager = new ProviderManager(
        { commands: { cursor: cursorAgent(root, capturePath, supportsHttp) } },
        new AgentHarnessRegistry([createCursorAcpHarness()]),
      );
      const result = await manager.run(nativeProviderRunInput({
        providerId: "cursor",
        conversationId: `cursor-${expectedType}-${resume}`,
        runId: `run-${resume}`,
        turnId: `turn-${resume}`,
        cwd: root,
        prompt: "Use chat tools",
        interactionMode: "build",
        access: "supervised",
        ...(resume ? { sessionId: "cursor-host-session" } : {}),
      }), { hostTools });
      expect(result.status).toBe("completed");
      expect(JSON.parse(readFileSync(capturePath, "utf8"))).toMatchObject({
        method: resume ? "session/load" : "session/new",
        type: expectedType,
        name: "inertia-chat-manager",
        ...(supportsHttp
          ? { urlIsLoopback: true, hasAuthorization: true }
          : {
              commandIsAbsolute: true,
              argsContainCredential: false,
              envNames: expect.arrayContaining([
                "INERTIA_HOST_MCP_TOKEN",
                "INERTIA_HOST_MCP_URL",
              ]),
            }),
      });
    }
  });

  it.each([false, true])("adds and disconnects OpenCode's directory-scoped bridge (failure=%s)", async (failAfterMcp) => {
    const root = portableFixtureRoot(`OpenCode host ${failAfterMcp ? "failure" : "success"}`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const manager = new ProviderManager(
      { commands: { opencode: openCodeServer(root, capturePath, failAfterMcp) } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const result = await manager.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: `opencode-${failAfterMcp}`,
      runId: "run-opencode",
      turnId: "turn-opencode",
      cwd: root,
      prompt: "Use chat tools",
      interactionMode: "build",
      access: "supervised",
    }), { hostTools });
    expect(result.status).toBe(failAfterMcp ? "failed" : "completed");
    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      port: number;
      captured: Array<Record<string, unknown>>;
      sessionPermission: Array<Record<string, unknown>>;
    };
    expect(capture.captured[0]).toMatchObject({
      kind: "mcp-add",
      name: "inertia-chat-manager",
      directory: root,
      type: "remote",
      urlIsLoopback: true,
      hasAuthorization: true,
      oauth: false,
    });
    expect(capture.captured.at(-1)).toMatchObject({
      kind: "mcp-disconnect",
      directory: root,
    });
    if (!failAfterMcp) {
      expect(capture.sessionPermission).toEqual(expect.arrayContaining([{
        permission: "inertia-chat-manager_*",
        pattern: "*",
        action: "allow",
      }]));
      const emittedPermission = "inertia-chat-manager_inertia_create_conversation";
      const matchingRules = capture.sessionPermission.filter(({ permission }) =>
        permission === "*"
        || (typeof permission === "string"
          && permission.endsWith("*")
          && emittedPermission.startsWith(permission.slice(0, -1))),
      );
      expect(matchingRules.at(-1)).toMatchObject({ action: "allow" });
    }
    if (!failAfterMcp) {
      expect(capture.captured.map(({ kind }) => kind)).toEqual([
        "mcp-add",
        "prompt",
        "mcp-disconnect",
      ]);
    }
    expect(existsSync(capturePath)).toBe(true);
    expect(await loopbackPortIsOpen(capture.port)).toBe(false);
  });

  it("does not start or inject provider MCP state for ordinary runs without host tools", async () => {
    const claudeRoot = portableFixtureRoot("Claude without host tools");
    const cursorRoot = portableFixtureRoot("Cursor without host tools");
    const openCodeRoot = portableFixtureRoot("OpenCode without host tools");
    roots.push(claudeRoot, cursorRoot, openCodeRoot);
    let claudeOptions: { mcpServers?: unknown; strictMcpConfig?: boolean } | undefined;
    const claude = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: ({ options }) => {
          claudeOptions = options;
          return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSuccessResult("Done", "completed");
          })());
        },
      })]),
    );
    const claudeResult = await claude.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-no-host-tools",
      runId: "run-no-host-tools",
      turnId: "turn-no-host-tools",
      cwd: claudeRoot,
      prompt: "Ordinary run",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(claudeResult.status).toBe("completed");
    expect(claudeOptions?.mcpServers).toBeUndefined();
    expect(claudeOptions?.strictMcpConfig).toBeUndefined();

    const cursorCapture = join(cursorRoot, "capture.json");
    const openCodeCapture = join(openCodeRoot, "capture.json");
    const cursor = new ProviderManager(
      { commands: { cursor: cursorAgent(cursorRoot, cursorCapture, true) } },
      new AgentHarnessRegistry([createCursorAcpHarness()]),
    );
    const cursorResult = await cursor.run(nativeProviderRunInput({
      providerId: "cursor",
      conversationId: "cursor-no-host-tools",
      runId: "run-no-host-tools",
      turnId: "turn-no-host-tools",
      cwd: cursorRoot,
      prompt: "Ordinary run",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(cursorResult.status).toBe("completed");
    expect(JSON.parse(readFileSync(cursorCapture, "utf8"))).toEqual({
      method: "session/new",
      count: 0,
    });

    const openCode = new ProviderManager(
      { commands: { opencode: openCodeServer(openCodeRoot, openCodeCapture) } },
      new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
    );
    const openCodeResult = await openCode.run(nativeProviderRunInput({
      providerId: "opencode",
      conversationId: "opencode-no-host-tools",
      runId: "run-no-host-tools",
      turnId: "turn-no-host-tools",
      cwd: openCodeRoot,
      prompt: "Ordinary run",
      interactionMode: "build",
      access: "supervised",
    }));
    expect(openCodeResult.status).toBe("completed");
    const openCodeEvents = JSON.parse(readFileSync(openCodeCapture, "utf8")) as {
      captured: Array<Record<string, unknown>>;
    };
    expect(openCodeEvents.captured).toEqual([{ kind: "prompt" }]);
  });

  it.each(["cursor", "opencode"] as const)("redacts %s MCP credentials from provider failures", async (provider) => {
    const root = portableFixtureRoot(`${provider} host tool diagnostic redaction`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const leakPath = join(root, "fixture-secret.json");
    const manager = provider === "cursor"
      ? new ProviderManager(
          { commands: { cursor: cursorAgent(root, capturePath, true, leakPath) } },
          new AgentHarnessRegistry([createCursorAcpHarness()]),
        )
      : new ProviderManager(
          { commands: { opencode: openCodeServer(root, capturePath, true, leakPath) } },
          new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
        );
    const result = await manager.run(nativeProviderRunInput({
      providerId: provider,
      conversationId: `${provider}-redaction`,
      runId: "run-redaction",
      turnId: "turn-redaction",
      cwd: root,
      prompt: "Ordinary run",
      interactionMode: "build",
      access: "supervised",
    }), { hostTools });
    const secret = JSON.parse(readFileSync(leakPath, "utf8")) as {
      token: string;
      url: string;
    };
    expect(result.status).toBe("failed");
    expect(result.error).not.toContain(secret.token);
    expect(result.error).not.toContain(secret.url);
  });

  it.each([
    { provider: "cursor" as const, supportsHttp: true, label: "Cursor HTTP" },
    { provider: "cursor" as const, supportsHttp: false, label: "Cursor stdio" },
    { provider: "opencode" as const, supportsHttp: true, label: "OpenCode" },
  ])("redacts MCP credentials from $label text and activity", async ({ provider, supportsHttp }) => {
    const root = portableFixtureRoot(`${provider} host activity redaction`);
    roots.push(root);
    const capturePath = join(root, "capture.json");
    const secretPath = join(root, "fixture-secret.json");
    const manager = provider === "cursor"
      ? new ProviderManager(
          { commands: { cursor: cursorAgent(root, capturePath, supportsHttp, undefined, secretPath) } },
          new AgentHarnessRegistry([createCursorAcpHarness()]),
        )
      : new ProviderManager(
          { commands: { opencode: openCodeServer(root, capturePath, false, undefined, secretPath) } },
          new AgentHarnessRegistry([createOpenCodeSdkHarness()]),
        );
    const visible: string[] = [];
    const result = await manager.run(nativeProviderRunInput({
      providerId: provider,
      conversationId: `${provider}-activity-redaction-${supportsHttp}`,
      runId: "run-activity-redaction",
      turnId: "turn-activity-redaction",
      cwd: root,
      prompt: "Ordinary run",
      interactionMode: "build",
      access: "supervised",
    }), {
      hostTools,
      onText: (event) => visible.push(event.text),
      onActivity: (event) => visible.push(JSON.stringify(event)),
    });
    if (!existsSync(secretPath)) {
      throw new Error(`Provider fixture did not capture its bridge secret: ${JSON.stringify(result)}`);
    }
    const secret = JSON.parse(readFileSync(secretPath, "utf8")) as {
      token: string;
      url: string;
    };
    expect(result.status).toBe("completed");
    const exposed = [...visible, result.text].join("\n");
    expect(exposed).toContain("[redacted]");
    expect(exposed).not.toContain(secret.token);
    expect(exposed).not.toContain(secret.url);
  });
});
