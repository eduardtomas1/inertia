import { deepStrictEqual, ok } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const projectKeys = ["id", "name", "path", "normalizedPath", "repositoryIdentity", "repositoryRoot", "repositoryRelativePath", "createdAt"];
const conversationKeys = ["id", "projectId", "title", "providerId", "modelSelection", "worktreePath", "branch", "createdAt"];
const select = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
export const historySettings = { theme: "dark", compactSidebar: true, terminalFontSize: 15 };

// This client speaks existing public runtime commands. It grants no filesystem
// or attachment capabilities and has one deadline for the complete proof.
function runtimeClient(url, deadlineAt) {
  const socket = new WebSocket(url, {
    headers: { Origin: "http://127.0.0.1" }, maxPayload: 1024 * 1024,
  });
  const pending = new Map();
  let snapshot = null;
  let failure = null;
  let welcomeResolve;
  let welcomeReject;
  const welcome = new Promise((resolve, reject) => {
    welcomeResolve = resolve;
    welcomeReject = reject;
  });
  const fail = (error) => {
    failure ??= error;
    welcomeReject(error);
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => {
    fail(new Error("Packaged history and terminal-turn proof exceeded its deadline."));
    socket.terminate();
  }, Math.max(1, deadlineAt - Date.now()));
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("Packaged runtime closed before history proof completed.")));
  socket.on("message", (data) => {
    try {
      const frame = JSON.parse(data.toString("utf8"));
      const event = frame.type === "runtime.event" ? frame.event : frame;
      if (event.type === "server.welcome" || event.type === "snapshot.updated") {
        snapshot = event.snapshot;
        welcomeResolve();
      }
      const entry = pending.get(event.requestId);
      if (!entry) return;
      if (event.type === "request.error") {
        pending.delete(event.requestId);
        entry.reject(new Error(`Packaged ${entry.type} failed: ${event.message}`));
      } else if (event.type === "request.ok" || event.type === "request.result") {
        pending.delete(event.requestId);
        entry.resolve(event.result ?? null);
      }
    } catch (error) { fail(error); }
  });
  return {
    welcome,
    snapshot: () => snapshot,
    request: (type, payload) => new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const requestId = randomUUID();
      pending.set(requestId, { resolve, reject, type });
      socket.send(JSON.stringify({ type, requestId, ...(payload ? { payload } : {}) }));
    }),
    close: () => { clearTimeout(timer); socket.close(); },
  };
}

async function detail(client, conversationId) {
  const result = await client.request("conversation.detail.load", { conversationId });
  ok(result?.kind === "conversation.detail" && result.state === "ready"
    && result.conversationId === conversationId, "Saved conversation was not loaded.");
  return result.detail;
}

export function assertHistoricalDetail(baseline, snapshot, value) {
  const project = snapshot.projects.find(({ id }) => id === baseline.project.id);
  ok(project, "Historical project was lost.");
  deepStrictEqual(select(project, projectKeys), baseline.project, "Historical project identity changed.");
  deepStrictEqual(select(value.conversation, conversationKeys), baseline.conversation,
    "Historical conversation identity/configuration changed.");
  deepStrictEqual(select(snapshot.settings, Object.keys(historySettings)), historySettings,
    "Historical settings changed.");
  for (const message of baseline.messages) {
    deepStrictEqual(value.messages.find(({ id }) => id === message.id), message,
      "Historical saved message/content/attachment changed.");
  }
  for (const turn of baseline.agentTurns) {
    const saved = value.agentTurns.find(({ id }) => id === turn.id);
    // A migration may add projection fields (for example the continuation
    // reason after v0.0.48). Every field actually saved by N-1 must survive.
    deepStrictEqual(saved && select(saved, Object.keys(turn)), turn,
      "Historical completed turn changed.");
  }
}

export function completedTurnProof(value, acceptance, challenge) {
  ok(acceptance?.kind === "message.accepted" && acceptance.disposition === "new-turn",
    "Packaged send did not durably accept a new turn.");
  const turn = value.agentTurns.find(({ id }) => id === acceptance.turnId);
  if (!turn || ["queued", "starting", "running"].includes(turn.status)) return null;
  ok(turn.status === "completed" && turn.startedAt && turn.completedAt
    && turn.runId && turn.providerSessionAfter && turn.providerId === "codex"
    && turn.conversationId === acceptance.conversationId
    && turn.userMessageId === acceptance.userMessageId,
  `Packaged provider turn did not complete with its original ownership (${turn.status}; ${turn.terminalReason ?? "no terminal reason"}).`);
  const user = value.messages.find(({ id }) => id === turn.userMessageId);
  const assistant = value.messages.find(({ id }) => id === turn.terminalAssistantMessageId);
  ok(user?.role === "user" && user.turnId === turn.id
    && user.conversationId === turn.conversationId && user.content === challenge,
  "Packaged turn lost its submitted message.");
  ok(assistant?.role === "assistant" && assistant.turnId === turn.id
    && assistant.conversationId === turn.conversationId
    && assistant.content === `Completed ${challenge}`,
  "Packaged turn did not persist the provider's exact terminal response.");
  return { messages: [user, assistant], agentTurns: [turn] };
}

export async function runPackagedHistorySmoke({ websocketUrl, workspaceDirectory, baseline = null,
  deadlineAt = Date.now() + 8_000 }) {
  const client = runtimeClient(websocketUrl, deadlineAt);
  try {
    await client.welcome;
    await client.request("provider.refresh", { providerId: "codex" });
    let conversationId;
    if (baseline) {
      assertHistoricalDetail(baseline, client.snapshot(),
        await detail(client, baseline.conversation.id));
      const conversation = await client.request("conversation.create", {
        projectId: baseline.project.id, title: "Candidate Fast compact proof",
        providerId: "codex", model: "package-smoke-model", useWorktree: false, activate: false,
      });
      ok(conversation?.kind === "conversation.created",
        "Packaged candidate conversation was not created.");
      conversationId = conversation.conversationId;
    } else {
      await client.request("settings.update", historySettings);
      const project = await client.request("project.create", {
        name: "Installed upgrade history Ω", path: workspaceDirectory,
      });
      ok(project?.kind === "project.created", "Packaged history project was not created.");
      const conversation = await client.request("conversation.create", {
        projectId: project.projectId, title: "Saved before installed upgrade Ω",
        providerId: "codex", model: "package-smoke-model", useWorktree: false, activate: false,
      });
      ok(conversation?.kind === "conversation.created", "Packaged history conversation was not created.");
      conversationId = conversation.conversationId;
    }
    const proofs = [];
    let value = await detail(client, conversationId);
    let providerSession = null;
    const setSpeed = async (speed) => {
      const providerOptions = { ...value.conversation.modelSelection.providerOptions };
      if (speed === "fast") providerOptions.fastMode = "priority";
      else delete providerOptions.fastMode;
      await client.request("conversation.update", {
        conversationId,
        modelSelection: { ...value.conversation.modelSelection, providerOptions },
      });
      value = await detail(client, conversationId);
      ok((value.conversation.modelSelection.providerOptions.fastMode ?? null)
        === (speed === "fast" ? "priority" : null),
      `Packaged conversation did not retain ${speed} mode.`);
    };
    const runTurn = async (speed, phase) => {
      await setSpeed(speed);
      const challenge = `package-smoke-${baseline ? "candidate" : "historical"}-${speed}:${randomUUID()}`;
      const acceptance = await client.request("message.send", { conversationId, content: challenge });
      let proof;
      do {
        value = await detail(client, conversationId);
        proof = completedTurnProof(value, acceptance, challenge);
        if (!proof) await new Promise((resolve) => setTimeout(resolve, 25));
      } while (!proof);
      const turn = proof.agentTurns[0];
      ok((turn.modelSelection.providerOptions.fastMode ?? null)
        === (speed === "fast" ? "priority" : null),
      `Packaged ${phase} turn did not retain ${speed} mode.`);
      if (providerSession === null) providerSession = turn.providerSessionAfter;
      else ok(turn.providerSessionBefore === providerSession
        && turn.providerSessionAfter === providerSession,
      `Packaged ${phase} turn did not resume the exact provider session.`);
      proofs.push(proof);
    };

    if (baseline) {
      await runTurn("fast", "initial Fast");
      await runTurn("standard", "Fast-to-Standard");
      await runTurn("fast", "Standard-to-Fast");
      const compacted = await client.request("conversation.compact", { conversationId });
      ok(compacted?.kind === "conversation.compacted"
        && compacted.conversationId === conversationId
        && compacted.providerId === "codex",
      "Packaged Fast context compaction did not complete on the exact conversation.");
      await runTurn("fast", "post-compaction Fast resume");
    } else {
      await runTurn("standard", "historical Standard");
    }
    const proof = {
      messages: proofs.flatMap((entry) => entry.messages),
      agentTurns: proofs.flatMap((entry) => entry.agentTurns),
    };
    if (baseline) {
      ok(proof.agentTurns.length === 4,
        "Packaged candidate speed/compaction sequence did not produce four terminal turns.");
      ok(proof.agentTurns.every((turn) => !baseline.agentTurns.some(({ id, runId }) =>
        id === turn.id || runId === turn.runId)),
      "Upgraded app reused the historical turn/run identity.");
      assertHistoricalDetail(baseline, client.snapshot(),
        await detail(client, baseline.conversation.id));
    }
    const project = client.snapshot().projects.find(({ id }) => id === value.conversation.projectId);
    return { project: select(project, projectKeys),
      conversation: select(value.conversation, conversationKeys), ...proof };
  } finally { client.close(); }
}
