/** Deterministic app-server protocol fixture; never claims to be a live model. */
export const projectToolsCodexFixtureSource = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv.includes("--help")) { console.log("Usage: codex app-server [OPTIONS]"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const threadId = "11111111-1111-4111-8111-111111111111";
let configs = {};
let turn = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line);
  if (process.env.INERTIA_TOOL_CAPTURE) fs.appendFileSync(process.env.INERTIA_TOOL_CAPTURE, JSON.stringify(msg) + "\n");
  const result = value => send({ id: msg.id, result: value });
  switch (msg.method) {
    case "initialize": result({ userAgent: "project-tools-fixture/0.159.3" }); break;
    case "model/list": result({ data: [{ id: "fixture-model", model: "fixture-model", displayName: "Fixture model", description: "Deterministic project tools test", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }], defaultReasoningEffort: "high", inputModalities: ["text", "image"], supportsPersonality: true }], nextCursor: null }); break;
    case "account/read": result({ account: { type: "chatgpt", email: "fixture@example.test", planType: "pro" }, requiresOpenaiAuth: false }); break;
    case "account/rateLimits/read": result({ rateLimits: { primary: null, secondary: null, credits: null }, rateLimitsByLimitId: {} }); break;
    case "thread/start": case "thread/resume":
      configs = msg.params.config || {};
      result({ thread: { id: msg.params.threadId || threadId }, cwd: process.cwd(), model: "fixture-model", serviceTier: null, initialTurnsPage: msg.method === "thread/resume" ? { data: [] } : null }); break;
    case "mcpServerStatus/list": {
      if (process.env.INERTIA_TOOL_SCENARIO === "hang") break;
      if (process.env.INERTIA_TOOL_SCENARIO === "unsupported") { send({ id: msg.id, error: { code: -32601, message: "Method not found" } }); break; }
      if (msg.params.threadId !== threadId) { send({ id: msg.id, error: { code: -32602, message: "Wrong thread" } }); break; }
      const connections = Object.entries(configs).filter(([key]) => key.startsWith("mcp_servers.inertia-project-"));
      result({ data: connections.map(([key, config]) => ({ name: key.slice("mcp_servers.".length), runtimeStatus: config.bearer_token_env_var && process.env[config.bearer_token_env_var] !== "synthetic-test-value" ? "authenticationRequired" : config.url.includes("unavailable") ? "failed" : "connected", authStatus: "unsupported", tools: { search_docs: { name: "search_docs" }, read_document: { name: "read_document" } }, toolsError: null })), nextCursor: null }); break;
    }
    case "turn/start": {
      const turnId = "fixture-turn-" + (++turn);
      result({ turn: { id: turnId, status: "inProgress", items: [], error: null } });
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      if (!msg.params.input.some(item => item.text?.includes("hold"))) setTimeout(() => {
        send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "reply", delta: "Fixture completed." } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      }, 40);
      break;
    }
    case "turn/interrupt":
      result({}); send({ method: "turn/completed", params: { threadId, turn: { id: "fixture-turn-" + turn, status: "interrupted", items: [], error: null } } }); break;
    default: if (msg.id !== undefined) result({});
  }
});
`;
