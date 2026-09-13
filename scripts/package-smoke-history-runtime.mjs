import { deepStrictEqual, ok } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const projectKeys = ["id", "name", "path", "normalizedPath", "repositoryIdentity", "repositoryRoot", "repositoryRelativePath", "createdAt"];
const conversationKeys = ["id", "projectId", "title", "providerId", "modelSelection", "worktreePath", "branch", "createdAt"];
const select = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));
export const historySettings = { theme: "dark", compactSidebar: true, terminalFontSize: 15 };

// This client speaks existing public runtime commands. It grants no filesystem
// or attachment capabilities and has one deadline for the complete proof.
function runtimeClient(url, deadlineAt, describeDeadline) {
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
    const diagnostic = describeDeadline?.(snapshot, [...pending.values()].map(({ type }) => type));
    fail(new Error(`Packaged history and terminal-turn proof exceeded its deadline.${
      diagnostic ? ` Proof state: ${JSON.stringify(diagnostic)}` : ""
    }`));
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
    snapshot: () => {
      if (failure) throw failure;
      return snapshot;
    },
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

export function completedTurnAdmissionProof(snapshot, turn) {
  const conversation = snapshot?.conversations?.find(({ id }) =>
    id === turn.conversationId);
  const run = snapshot?.runs?.find(({ id }) => id === turn.runId);
  const owned = snapshot?.lifecycleDiagnostics?.ownedResources;
  return conversation?.status === "completed"
    && conversation.latestTurn?.id === turn.id
    && conversation.latestTurn.status === "completed"
    && run?.status === "succeeded"
    && typeof run.finishedAt === "string"
    && Number.isFinite(Date.parse(run.finishedAt))
    && run.canStop === false
    && owned?.providerRuns === 0
    && owned.turns === 0
    && owned.workspaceRuns === 0
    && owned.interactions === 0;
}

export async function runPackagedWorkspaceDiscovery(websocketUrl, projectId) {
  const client = runtimeClient(websocketUrl, Date.now() + 100_000);
  try {
    await client.welcome;
    const result = await client.request("git.workspace.refresh", { projectId });
    ok(result?.kind === "git.workspace.status", "Packaged workspace discovery returned no status.");
    ok(result.status.repositories.some((repository) => repository.repositoryPath === "."
      && repository.state === "ready"), "The existing workspace repository did not open.");
  } finally { client.close(); }
}

export async function resumePackagedHistorySmoke(websocketUrl, baseline) {
  const client = runtimeClient(websocketUrl, Date.now() + 30_000);
  try {
    await client.welcome;
    await client.request("provider.refresh", { providerId: "codex" });
    assertHistoricalDetail(baseline, client.snapshot(), await detail(client, baseline.conversation.id));
    const challenge = `package-smoke-candidate-standard:${randomUUID()}`;
    const acceptance = await client.request("message.send", {
      conversationId: baseline.conversation.id, content: challenge, activate: false,
    });
    let proof;
    do {
      proof = completedTurnProof(await detail(client, baseline.conversation.id), acceptance, challenge);
      if (!proof) await new Promise((resolve) => setTimeout(resolve, 25));
    } while (!proof);
    const session = baseline.agentTurns.at(-1).providerSessionAfter;
    ok(proof.agentTurns[0].providerSessionBefore === session
      && proof.agentTurns[0].providerSessionAfter === session,
    "The updated app did not resume the saved provider session.");
    while (!completedTurnAdmissionProof(client.snapshot(), proof.agentTurns[0])) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertHistoricalDetail(baseline, client.snapshot(), await detail(client, baseline.conversation.id));
    return { ...baseline, messages: [...baseline.messages, ...proof.messages],
      agentTurns: [...baseline.agentTurns, ...proof.agentTurns] };
  } finally { client.close(); }
}

export async function runPackagedHistorySmoke({ websocketUrl, workspaceDirectory, baseline = null,
  deadlineAt = Date.now() + 8_000 }) {
  const startedAt = Date.now();
  let phase = "welcome";
  let phaseStartedAt = startedAt;
  let turnNumber = 0;
  let completedTurns = 0;
  let observedTurn = null;
  const markPhase = (value) => { phase = value; phaseStartedAt = Date.now(); };
  const client = runtimeClient(websocketUrl, deadlineAt, (snapshot, pendingCommands) => {
    // Only fixed state classifications leave this synthetic proof. Never dump
    // snapshots, command payloads, IDs, provider output, paths or credentials.
    const classify = (value, allowed) => allowed.includes(value) ? value : "unknown";
    const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
    const conversation = Array.isArray(snapshot?.conversations) && observedTurn
      ? snapshot.conversations.find((candidate) => candidate?.id === observedTurn.conversationId) : null;
    const run = Array.isArray(snapshot?.runs) && observedTurn
      ? snapshot.runs.find((candidate) => candidate?.id === observedTurn.runId) : null;
    const owned = snapshot?.lifecycleDiagnostics?.ownedResources;
    const now = Date.now();
    return {
      phase, turnNumber, completedTurns,
      initialBudgetMs: Math.max(0, deadlineAt - startedAt),
      elapsedMs: Math.max(0, now - startedAt),
      phaseElapsedMs: Math.max(0, now - phaseStartedAt),
      pendingCommands: [...new Set(pendingCommands.map((type) => classify(type, [
        "provider.refresh", "settings.update", "project.create", "conversation.create",
        "conversation.detail.load", "conversation.update", "message.send", "conversation.compact",
      ])))],
      turnStatus: classify(observedTurn?.status, ["queued", "starting", "running", "waiting-for-approval", "waiting-for-input", "completed", "failed", "cancelled", "interrupted"]),
      conversationStatus: classify(conversation?.status, ["idle", "running", "needs-input", "completed", "failed"]),
      latestTurnMatches: Boolean(observedTurn && conversation?.latestTurn?.id === observedTurn.id),
      runStatus: classify(run?.status, ["running", "waiting", "succeeded", "failed", "cancelled"]),
      runCanStop: typeof run?.canStop === "boolean" ? run.canStop : null,
      ownedResources: Object.fromEntries(["providerRuns", "turns", "workspaceRuns", "interactions"]
        .map((key) => [key, count(owned?.[key])])),
    };
  });
  try {
    await client.welcome;
    markPhase("provider-refresh");
    await client.request("provider.refresh", { providerId: "codex" });
    let conversationId;
    if (baseline) {
      markPhase("historical-detail");
      assertHistoricalDetail(baseline, client.snapshot(),
        await detail(client, baseline.conversation.id));
      markPhase("conversation-create");
      const conversation = await client.request("conversation.create", {
        projectId: baseline.project.id, title: "Candidate Fast compact proof",
        providerId: "codex", model: "package-smoke-model", useWorktree: false, activate: false,
      });
      ok(conversation?.kind === "conversation.created",
        "Packaged candidate conversation was not created.");
      conversationId = conversation.conversationId;
    } else {
      markPhase("settings-update");
      await client.request("settings.update", historySettings);
      markPhase("project-create");
      const project = await client.request("project.create", {
        name: "Installed upgrade history Ω", path: workspaceDirectory,
      });
      ok(project?.kind === "project.created", "Packaged history project was not created.");
      markPhase("conversation-create");
      const conversation = await client.request("conversation.create", {
        projectId: project.projectId, title: "Saved before installed upgrade Ω",
        providerId: "codex", model: "package-smoke-model", useWorktree: false, activate: false,
      });
      ok(conversation?.kind === "conversation.created", "Packaged history conversation was not created.");
      conversationId = conversation.conversationId;
    }
    const proofs = [];
    markPhase("conversation-detail");
    let value = await detail(client, conversationId);
    const selectedConversationId = client.snapshot().activeConversationId;
    let providerSession = null;
    const setSpeed = async (speed, phase) => {
      const providerOptions = { ...value.conversation.modelSelection.providerOptions };
      if (speed === "fast") providerOptions.fastMode = "priority";
      else delete providerOptions.fastMode;
      try {
        markPhase("mode-update");
        await client.request("conversation.update", {
          conversationId,
          modelSelection: { ...value.conversation.modelSelection, providerOptions },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Packaged ${phase} mode configuration admission failed: ${detail}`,
          { cause: error });
      }
      markPhase("mode-detail");
      value = await detail(client, conversationId);
      ok((value.conversation.modelSelection.providerOptions.fastMode ?? null)
        === (speed === "fast" ? "priority" : null),
      `Packaged conversation did not retain ${speed} mode.`);
    };
    const runTurn = async (speed, phase) => {
      turnNumber += 1;
      observedTurn = null;
      await setSpeed(speed, phase);
      const challenge = `package-smoke-${baseline ? "candidate" : "historical"}-${speed}:${randomUUID()}`;
      markPhase("message-send");
      const acceptance = await client.request("message.send", {
        conversationId, content: challenge, activate: false,
      });
      let proof;
      markPhase("terminal-persistence");
      do {
        value = await detail(client, conversationId);
        observedTurn = value.agentTurns.find(({ id }) => id === acceptance?.turnId) ?? null;
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
      markPhase("admission-idle");
      while (!completedTurnAdmissionProof(client.snapshot(), turn)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      ok(client.snapshot().activeConversationId === selectedConversationId,
        `Packaged ${phase} background turn changed the selected conversation.`);
      proofs.push(proof);
      completedTurns += 1;
    };

    if (baseline) {
      await runTurn("fast", "initial Fast");
      await runTurn("standard", "Fast-to-Standard");
      await runTurn("fast", "Standard-to-Fast");
      markPhase("compaction");
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
      markPhase("final-historical-detail");
      assertHistoricalDetail(baseline, client.snapshot(),
        await detail(client, baseline.conversation.id));
    }
    const project = client.snapshot().projects.find(({ id }) => id === value.conversation.projectId);
    return { project: select(project, projectKeys),
      conversation: select(value.conversation, conversationKeys), ...proof };
  } finally { client.close(); }
}
