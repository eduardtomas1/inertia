import * as acp from "@agentclientprotocol/sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

if (typeof acp.client !== "function"
  || typeof acp.methods?.client?.session?.requestPermission !== "string") {
  throw new Error("ACP client builder or request-permission method is unavailable.");
}
const cursorClient = acp.client({ name: "Inertia provider drift" });
if (typeof cursorClient?.onRequest !== "function"
  || typeof cursorClient?.onNotification !== "function") {
  throw new Error("ACP client runtime surface is incompatible.");
}

if (typeof claudeQuery !== "function") {
  throw new Error("Claude Agent SDK query factory is unavailable.");
}

const openCodeClient = createOpencodeClient({
  baseUrl: "http://127.0.0.1:9",
  directory: ".",
  throwOnError: true,
});
if (typeof openCodeClient?.provider?.list !== "function"
  || typeof openCodeClient?.permission?.reply !== "function"
  || typeof openCodeClient?.question?.reply !== "function") {
  throw new Error("OpenCode provider, permission, or question surface is incompatible.");
}

console.log("Latest provider SDK runtime surfaces are compatible.");
