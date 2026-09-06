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
let requestedServiceTier;
let compactTurnId = null;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const tier = (params) => {
  if (!hasOwn(params, "serviceTier")
    || (params.serviceTier !== null && params.serviceTier !== "priority")) {
    throw new Error("The packaged request has no exact supported service tier.");
  }
  return params.serviceTier;
};
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
    defaultServiceTier: "default",
    serviceTiers: [{ id: "priority", name: "Fast" }],
  }], nextCursor: null });
  if (message.method === "account/rateLimits/read") return result({ rateLimits: null });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || `package-smoke-${randomUUID()}`;
    requestedServiceTier = tier(message.params);
    return result({
      thread: { id: threadId },
      model: "package-smoke-model",
      serviceTier: requestedServiceTier === "priority" ? "priority" : "default",
      ...(message.params.excludeTurns === true
        ? { initialTurnsPage: { data: [{ id: "package-smoke-previous-turn" }] } }
        : {}),
    });
  }
  if (message.method === "turn/start" && threadId === message.params.threadId) {
    const prompt = message.params.input.filter((item) => item.type === "text")
      .map((item) => item.text).join("\n");
    const token = /package-smoke-(?:historical|candidate)-(?:fast|standard):[0-9a-f-]{36}/u.exec(prompt)?.[0];
    if (!token) throw new Error("The packaged turn has no exact smoke challenge.");
    const expectedTier = token.includes("-fast:") ? "priority" : null;
    if (tier(message.params) !== expectedTier || requestedServiceTier !== expectedTier) {
      return send({ id: message.id, error: {
        code: -32602,
        message: "The packaged turn service tier does not match its exact challenge.",
      } });
    }
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
  if (message.method === "thread/compact/start" && threadId === message.params.threadId) {
    if (requestedServiceTier !== "priority") {
      return send({ id: message.id, error: {
        code: -32602,
        message: "The packaged compact request did not retain Fast mode.",
      } });
    }
    compactTurnId = randomUUID();
    const itemId = randomUUID();
    const lifecycleAtMs = Date.now();
    result({});
    send({ method: "turn/started", params: {
      threadId, turn: { id: compactTurnId, status: "inProgress", items: [], error: null },
    } });
    send({ method: "item/started", params: {
      threadId, turnId: compactTurnId, startedAtMs: lifecycleAtMs,
      item: { id: itemId, type: "contextCompaction" },
    } });
    send({ method: "item/completed", params: {
      threadId, turnId: compactTurnId, completedAtMs: lifecycleAtMs,
      item: { id: itemId, type: "contextCompaction" },
    } });
    return send({ method: "turn/completed", params: {
      threadId,
      turn: { id: compactTurnId, status: "completed", items: [], error: null },
    } });
  }
  if (message.method === "thread/turns/list" && compactTurnId) {
    return result({ data: [
      { id: compactTurnId },
      { id: "package-smoke-previous-turn" },
    ] });
  }
  send({ id: message.id, error: { code: -32601, message: "Unsupported package-smoke method" } });
});
