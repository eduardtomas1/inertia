import * as acp from "@agentclientprotocol/sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

if (typeof acp.client !== "function"
  || typeof acp.methods?.client?.session?.requestPermission !== "string") {
  throw new Error("ACP client builder or request-permission method is unavailable.");
}
const cursorClient = acp.client({ name: "Inertia provider drift" });
if (typeof cursorClient?.onRequest !== "function"
  || typeof cursorClient?.onNotification !== "function"
  || typeof cursorClient?.connectWith !== "function"
  || typeof acp.ndJsonStream !== "function"
  || typeof acp.methods?.agent?.initialize !== "string"
  || typeof acp.methods?.agent?.session?.new !== "string"
  || typeof acp.methods?.agent?.session?.load !== "string"
  || typeof acp.methods?.agent?.session?.prompt !== "string"
  || typeof acp.methods?.agent?.session?.cancel !== "string"
  || typeof acp.methods?.agent?.session?.setMode !== "string"
  || typeof acp.methods?.agent?.session?.setConfigOption !== "string") {
  throw new Error("ACP client runtime surface is incompatible.");
}

if (typeof claudeQuery !== "function") {
  throw new Error("Claude Agent SDK query factory is unavailable.");
}

const anthropicClient = new Anthropic({
  apiKey: "provider-drift-placeholder",
  baseURL: "http://127.0.0.1:9",
});
if (typeof anthropicClient?.messages?.create !== "function"
  || typeof anthropicClient?.messages?.countTokens !== "function") {
  throw new Error("Anthropic Messages SDK runtime surface is incompatible.");
}

const mcpClient = new McpClient({
  name: "Inertia provider drift",
  version: "1.0.0",
});
const mcpTransports = InMemoryTransport.createLinkedPair();
if (typeof mcpClient?.connect !== "function"
  || typeof mcpClient?.close !== "function"
  || typeof mcpClient?.listTools !== "function"
  || typeof mcpClient?.callTool !== "function"
  || typeof mcpClient?.listResources !== "function"
  || typeof mcpClient?.readResource !== "function"
  || mcpTransports.length !== 2
  || mcpTransports.some((transport) => typeof transport?.start !== "function")) {
  throw new Error("MCP client or in-memory transport runtime surface is incompatible.");
}

const openCodeClient = createOpencodeClient({
  baseUrl: "http://127.0.0.1:9",
  directory: ".",
  throwOnError: true,
});
if (typeof openCodeClient?.provider?.list !== "function"
  || typeof openCodeClient?.event?.subscribe !== "function"
  || typeof openCodeClient?.session?.promptAsync !== "function"
  || typeof openCodeClient?.session?.abort !== "function"
  || typeof openCodeClient?.permission?.reply !== "function"
  || typeof openCodeClient?.question?.reply !== "function"
  || typeof openCodeClient?.question?.reject !== "function") {
  throw new Error("OpenCode provider, permission, or question surface is incompatible.");
}

console.log("Latest provider SDK runtime surfaces are compatible.");
