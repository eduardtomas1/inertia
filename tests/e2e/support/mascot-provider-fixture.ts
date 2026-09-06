/** Real provider transport, with test-owned gates for deterministic desktop screenshots. */
export const mascotProviderFixture = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadId = "mascot-context-thread";
const turnId = "mascot-context-turn";
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const waitForGate = (name, callback) => {
  if (fs.existsSync(path.join(process.cwd(), ".git", "mascot-" + name))) callback();
  else setTimeout(() => waitForGate(name, callback), 50);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "mascot-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadId = message.params.threadId || threadId;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture", cwd: process.cwd() } });
  }
  if (message.method === "turn/start") {
    const turn = { id: turnId, status: "inProgress", items: [], error: null };
    send({ id: message.id, result: { turn } });
    notify("turn/started", { turn });
    notify("turn/plan/updated", { plan: [
      { step: "Move the bubble above the mascot", status: "completed" },
      { step: "Check the question and approval flow", status: "inProgress" },
      { step: "Verify keyboard access", status: "pending" },
    ] });
    waitForGate("question", () => send({ id: "mascot-question", method: "item/tool/requestUserInput", params: {
      threadId, turnId, itemId: "question-item", questions: [{ id: "scope", header: "Follow chats",
        question: "Should I follow all active chats, or only the chat you have selected?",
        options: [{ label: "All active chats", description: "Bring questions from any chat to your attention." }],
      }],
    } }));
    return;
  }
  if (message.id === "mascot-question" && message.result) {
    notify("serverRequest/resolved", { requestId: "mascot-question" });
    send({ id: "mascot-approval", method: "item/commandExecution/requestApproval", params: {
      threadId, turnId, itemId: "approval-item", command: "npm test", cwd: process.cwd(),
      reason: "Run the mascot tests to check the new bubble and keyboard controls.", availableDecisions: ["accept", "decline"],
    } });
    return;
  }
  if (message.id === "mascot-approval" && message.result) {
    notify("serverRequest/resolved", { requestId: "mascot-approval" });
    waitForGate("complete", () => {
      const text = "The mascot now shows live progress, questions, and results. The bubble sits above its head, and keyboard checks passed.";
      notify("item/completed", { item: { id: "final-answer", type: "agentMessage", text } });
      notify("turn/completed", { turn: { id: turnId, status: "completed", items: [], error: null } });
    });
  }
});
`;
