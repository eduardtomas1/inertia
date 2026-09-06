// Deliberately secret-free. Executed by the relocated native Node executable
// through the same app-server boundary as packaged Codex.
const { randomUUID } = require("node:crypto");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--help") {
  console.log("codex app-server - Run the app server");
  process.exit(0);
}
if (args.length !== 0) process.exit(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let threadId = null;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (Buffer.byteLength(line) > 128 * 1024) process.exit(2);
  const message = JSON.parse(line);
  const result = (value) => send({ id: message.id, result: value });
  if (message.method === "initialize") return result({ userAgent: "package-smoke" });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return result({ data: [{
    id: "package-smoke-model", model: "package-smoke-model", displayName: "Package smoke",
    description: "Deterministic packaged turn fixture", isDefault: true,
    defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fixture" }],
  }], nextCursor: null });
  if (message.method === "account/rateLimits/read") return result({ rateLimits: null });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || `package-smoke-${randomUUID()}`;
    return result({ thread: { id: threadId }, model: "package-smoke-model" });
  }
  if (message.method === "turn/start" && threadId === message.params.threadId) {
    const prompt = message.params.input.filter((item) => item.type === "text")
      .map((item) => item.text).join("\n");
    const token = /package-smoke-(?:historical|candidate):[0-9a-f-]{36}/u.exec(prompt)?.[0];
    if (!token) throw new Error("The packaged turn has no exact smoke challenge.");
    const turn = { id: randomUUID(), status: "inProgress", items: [], error: null };
    const itemId = randomUUID();
    result({ turn });
    send({ method: "turn/started", params: { threadId, turn } });
    send({ method: "item/agentMessage/delta", params: {
      threadId, turnId: turn.id, itemId, delta: `Completed ${token}`,
    } });
    send({ method: "item/completed", params: {
      threadId, turnId: turn.id,
      item: { id: itemId, type: "agentMessage", text: `Completed ${token}` },
    } });
    return send({ method: "turn/completed", params: {
      threadId, turn: { ...turn, status: "completed" },
    } });
  }
  send({ id: message.id, error: { code: -32601, message: "Unsupported package-smoke method" } });
});
