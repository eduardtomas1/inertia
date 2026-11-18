/** Loaded by Pi's own extension loader; imports resolve against the user's Pi 1.x install. */
export const PI_BRIDGE_SOURCE = String.raw`
import { Type } from "typebox";
import { createBashToolDefinition, createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export default async function inertiaPiBridge(pi) {
  const ownPath = resolve(fileURLToPath(import.meta.url));
  const endpoint = process.env.INERTIA_PI_MCP_URL;
  const token = process.env.INERTIA_PI_MCP_TOKEN;
  const ready = process.env.INERTIA_PI_READY;
  const mode = process.env.INERTIA_PI_ACCESS;
  const nativeTools = process.env.INERTIA_PI_NATIVE_TOOLS === "1";
  const instructions = process.env.INERTIA_PI_INSTRUCTIONS || "";
  const toolEnvironment = JSON.parse(process.env.INERTIA_PI_TOOL_ENV || "{}");
  for (const key of Object.keys(process.env)) if (key.startsWith("INERTIA_PI_")) delete process.env[key];
  const prefix = "mcp__inertia__";
  const hostNames = new Set();
  const readOnly = new Set(["read", "grep", "find", "ls"]);
  const edits = new Set(["edit", "write"]);
  let sequence = 0;
  let catalogLoaded = false;
  let loading;
  const ownedTool = (name) => pi.getAllTools().some((tool) => tool.name === name &&
    typeof tool.sourceInfo?.path === "string" && resolve(tool.sourceInfo.path) === ownPath);
  const builtin = (name) => pi.getAllTools().some((tool) => tool.name === name &&
    tool.sourceInfo?.source === "builtin");
  const rpc = async (method, params, signal) => {
    if (!endpoint || !token) throw new Error("Inertia host-tool connection is unavailable.");
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid Inertia host-tool endpoint.");
    const id = ++sequence;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), method === "tools/call" ? 300000 : 10000);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok || !response.body) throw new Error("Inertia host-tool request failed.");
      const reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 16 * 1024 * 1024) { controller.abort(); throw new Error("Inertia host-tool result exceeded its limit."); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (result.id !== id || result.error) throw new Error("Inertia host-tool response was rejected.");
      return result.result;
    } finally { clearTimeout(timer); }
  };
  const start = async (ctx) => {
    if (catalogLoaded || !endpoint) return;
    loading ??= (async () => {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "inertia-pi", version: "1" } }, ctx.signal);
      const result = await rpc("tools/list", {}, ctx.signal);
      if (!Array.isArray(result?.tools) || result.tools.length > 128) throw new Error("Invalid Inertia tool catalog.");
      for (const tool of result.tools) {
        if (typeof tool.name !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(tool.name)) throw new Error("Invalid Inertia tool identity.");
        const name = prefix + tool.name;
        hostNames.add(name);
        pi.registerTool({
          name, label: tool.name, description: tool.description || tool.name,
          parameters: Type.Unsafe({ ...tool.inputSchema, type: "object", properties: tool.inputSchema?.properties || {} }),
          exposure: "direct",
          async execute(_id, params, signal) {
            const result = await rpc("tools/call", { name: tool.name, arguments: params || {} }, signal);
            const content = Array.isArray(result?.content) ? result.content.filter((part) =>
              part?.type === "text" && typeof part.text === "string" ||
              part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") : [];
            return { content: content.length ? content : [{ type: "text", text: "No model-visible output." }],
              details: { server: "inertia", tool: tool.name }, isError: result?.isError === true };
          },
        });
      }
      catalogLoaded = true;
    })();
    await loading;
  };
  // Pi's provider process retains its native authentication. Its shell tools
  // receive a separate, credential-free environment from the privileged host.
  pi.registerTool(createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: true,
    spawnHook: (context) => ({ ...context, env: { ...toolEnvironment } }) }));
  if (process.platform === "win32") pi.registerTool(createPowerShellToolDefinition(process.cwd(), {
    exposeSessionEnvironment: true, spawnHook: (context) => ({ ...context, env: { ...toolEnvironment } }),
  }));
  pi.on("tool_call", async (event, ctx) => {
    if (hostNames.has(event.toolName) && ownedTool(event.toolName)) return;
    if (!nativeTools || mode === "read-only") {
      if (nativeTools && readOnly.has(event.toolName) && builtin(event.toolName)) return;
      return { block: true, reason: "This Inertia turn does not authorize this native tool." };
    }
    if (mode === "full") return;
    if (readOnly.has(event.toolName) && builtin(event.toolName)) return;
    if (mode === "auto-edit" && edits.has(event.toolName) && builtin(event.toolName)) return;
    const payload = JSON.stringify({ tool: event.toolName, input: event.input });
    if (payload.length > 32768) return { block: true, reason: "Tool approval request exceeds its limit." };
    const approved = await ctx.ui.confirm("Inertia tool approval:" + ready, payload, { signal: ctx.signal });
    if (!approved) return { block: true, reason: "The tool was declined in Inertia." };
  });
  const reconcile = () => {
    const allowed = pi.getActiveTools().filter((name) => nativeTools || hostNames.has(name) && ownedTool(name));
    for (const name of hostNames) if (ownedTool(name) && !allowed.includes(name)) allowed.push(name);
    pi.setActiveTools(allowed);
  };
  pi.on("session_start", async (_event, ctx) => {
    await start(ctx); reconcile();
    ctx.ui.notify("inertia-ready:" + ready, "info");
  });
  pi.on("session_tree", () => reconcile());
  pi.on("model_select", () => reconcile());
  pi.on("before_agent_start", (event) => {
    reconcile();
    if (!instructions) return;
    if (event.systemPromptOptions?.sections && event.systemPromptOptions.forceSystemPrompt === undefined) {
      event.systemPromptOptions.sections.inertia = instructions; return;
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + instructions };
  });
}
`;
