/** Real Codex App Server transport for three chats, released step by step through test-owned gates. */
export const mascotChatsProviderFixture = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
let threadCounter = 0;
const turns = new Map();
const requestOwners = new Map();
const cmd = (id, command, status, output) => ({ id, type: "commandExecution", command, status, ...(output ? { aggregatedOutput: output, exitCode: 0 } : {}) });
const SCRIPTS = {
  A: [
    (t) => [
      ["turn/plan/updated", { plan: [
        { step: "Read the mascot status publisher and list which runtime events reach the bubble", status: "completed" },
        { step: "Split the feed into per-chat summaries with explicit waiting, working, done and failed states", status: "inProgress" },
        { step: "Update the renderer copy", status: "pending" },
        { step: "Run the focused tests", status: "pending" },
      ] }],
      ["item/agentMessage/delta", { itemId: "a-c1", delta: "I'll start by reading the mascot status publisher to see which runtime events actually reach the bubble." }],
      ["item/completed", { item: { id: "a-c1", type: "agentMessage", text: "I'll start by reading the mascot status publisher to see which runtime events actually reach the bubble." } }],
      ["item/started", { item: cmd("a-cmd1", "rg -n \\"mascot\\" src/server/runtime", "inProgress") }],
    ],
    (t) => [
      ["item/completed", { item: cmd("a-cmd1", "rg -n \\"mascot\\" src/server/runtime", "completed", "src/server/runtime/mascot-status.ts:68: export class MascotStatusPublisher") }],
      ["item/agentMessage/delta", { itemId: "a-c2", delta: "The publisher overwrites the preview with every tool title, so I'm going to keep the assistant's own words instead." }],
      ["item/completed", { item: { id: "a-c2", type: "agentMessage", text: "The publisher overwrites the preview with every tool title, so I'm going to keep the assistant's own words instead." } }],
      ["item/started", { item: { id: "a-fc1", type: "fileChange", status: "inProgress", changes: [{ path: "src/server/runtime/mascot-status.ts", kind: { type: "update" }, diff: "" }] } }],
    ],
    (t) => [
      ["item/completed", { item: { id: "a-fc1", type: "fileChange", status: "completed", changes: [{ path: "src/server/runtime/mascot-status.ts", kind: { type: "update" }, diff: "" }] } }],
      ["request", "item/tool/requestUserInput", { itemId: "a-q", questions: [{ id: "scope", header: "Scope",
        question: "Should the mascot keep showing a finished chat until you open it, even while another chat is still running, or should running work always take priority over results you have not seen yet?",
        options: [{ label: "Keep finished chats visible", description: "Results stay until opened." }, { label: "Running work first", description: "Current behaviour." }] }] }],
    ],
    (t) => [
      ["item/agentMessage/delta", { itemId: "a-c3", delta: "Thanks. Running the focused tests now." }],
      ["item/completed", { item: { id: "a-c3", type: "agentMessage", text: "Thanks. Running the focused tests now." } }],
      ["item/started", { item: cmd("a-cmd2", "npm test -- tests/server/mascot-status.test.ts", "inProgress") }],
      ["turn/plan/updated", { plan: [
        { step: "Read the mascot status publisher and list which runtime events reach the bubble", status: "completed" },
        { step: "Split the feed into per-chat summaries with explicit waiting, working, done and failed states", status: "completed" },
        { step: "Update the renderer copy", status: "completed" },
        { step: "Run the focused tests", status: "inProgress" },
      ] }],
    ],
    (t) => [
      ["item/completed", { item: cmd("a-cmd2", "npm test -- tests/server/mascot-status.test.ts", "completed", "42 passed") }],
      ["item/completed", { item: { id: "a-final", type: "agentMessage", text: "## Summary\\n\\nI split the **status feed** into \`MascotFeed\` per chat and kept the ranking stable.\\n\\n- Updated \`src/server/runtime/mascot-status.ts\`\\n- Added tests in [mascot-status.test.ts](tests/server/mascot-status.test.ts)\\n\\nAll 42 tests pass. Next I would look at the bubble copy, which still says *Command* for most tool calls, and at how finished chats are hidden behind running ones." } }],
      ["complete", "completed"],
    ],
  ],
  B: [
    (t) => [
      ["item/agentMessage/delta", { itemId: "b-c1", delta: "Reproducing the flaky login test first." }],
      ["item/completed", { item: { id: "b-c1", type: "agentMessage", text: "Reproducing the flaky login test first." } }],
      ["item/started", { item: cmd("b-cmd1", "npx vitest run tests/login.test.ts --repeat 20", "inProgress") }],
    ],
    (t) => [
      ["item/completed", { item: cmd("b-cmd1", "npx vitest run tests/login.test.ts --repeat 20", "completed", "3 failed") }],
      ["request", "item/commandExecution/requestApproval", { itemId: "b-ap", command: "rm -rf node_modules/.vite && npm ci", cwd: process.cwd(),
        reason: "Clear the Vite cache and reinstall dependencies, because the failure only appears with a stale optimized dependency bundle.", availableDecisions: ["accept", "decline"] }],
    ],
    (t) => [
      ["complete", "failed", "The login test still fails after reinstalling: TimeoutError waiting for selector \\"#submit\\" after 30000ms in tests/login.test.ts:88. The fixture server never started because port 5173 was already in use by another process."],
    ],
  ],
  C: [
    (t) => [
      ["turn/plan/updated", { plan: [
        { step: "Collect merged PRs", status: "inProgress" },
        { step: "Group by area", status: "pending" },
        { step: "Write the notes", status: "pending" },
      ] }],
      ["item/started", { item: cmd("c-cmd1", "gh pr list --state merged --limit 50", "inProgress") }],
    ],
    (t) => [
      ["item/completed", { item: cmd("c-cmd1", "gh pr list --state merged --limit 50", "completed", "50 PRs") }],
      ["item/started", { item: cmd("c-cmd2", "git log --oneline v0.0.70..HEAD", "inProgress") }],
    ],
    (t) => [
      ["item/completed", { item: cmd("c-cmd2", "git log --oneline v0.0.70..HEAD", "completed", "12 commits") }],
      ["item/completed", { item: { id: "c-final", type: "agentMessage", text: "Release notes drafted in CHANGELOG.md under v0.0.72." } }],
      ["complete", "completed"],
    ],
  ],
};
const run = (turn, index) => {
  const script = SCRIPTS[turn.tag];
  if (!script || index >= script.length) return;
  const gate = path.join(process.cwd(), ".git", \`mchats-\${turn.tag}-\${index + 1}\`);
  if (!fs.existsSync(gate)) { setTimeout(() => run(turn, index), 50); return; }
  for (const [method, a, b, c] of script[index](turn)) {
    if (method === "request") {
      const id = \`req-\${turn.tag}-\${index}\`;
      requestOwners.set(id, turn);
      send({ id, method: a, params: { threadId: turn.threadId, turnId: turn.id, ...b } });
    } else if (method === "complete") {
      send({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.id, status: a, items: [], error: b ? { message: b } : null } } });
    } else {
      send({ method, params: { threadId: turn.threadId, turnId: turn.id, ...a } });
    }
  }
  setTimeout(() => run(turn, index + 1), 50);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "mascot-chats" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadCounter += 1;
    const threadId = message.params.threadId || \`chats-thread-\${process.pid}-\${threadCounter}\`;
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture", cwd: process.cwd(), serviceTier: null, initialTurnsPage: null } });
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "turn/start") {
    const prompt = (message.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
    const tag = (/\\[([A-Z])\\]/u.exec(prompt) || [])[1] || "A";
    const turn = { id: \`chats-turn-\${tag}\`, tag, threadId: message.params.threadId };
    turns.set(turn.id, turn);
    const body = { id: turn.id, status: "inProgress", items: [], error: null };
    send({ id: message.id, result: { turn: body } });
    send({ method: "turn/started", params: { threadId: turn.threadId, turn: body } });
    run(turn, 0);
    return;
  }
  if (typeof message.id === "string" && requestOwners.has(message.id) && (message.result || message.error)) {
    const turn = requestOwners.get(message.id);
    requestOwners.delete(message.id);
    send({ method: "serverRequest/resolved", params: { threadId: turn.threadId, turnId: turn.id, requestId: message.id } });
    return;
  }
  if (message.id !== undefined && message.method) send({ id: message.id, result: {} });
});
`;
