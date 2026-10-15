import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";

export const SCREEN_OPEN_LONG_CHAT = "Long history chat";
export const SCREEN_OPEN_SHORT_CHAT = "Short history chat";
export const SCREEN_OPEN_LONG_TURNS = 300;
export const SCREEN_OPEN_SHORT_TURNS = 20;
export const SCREEN_OPEN_EXTRA_CHATS = 12;

export interface ScreenOpenSeed {
  homeConversationId: string;
  longConversationId: string;
  shortConversationId: string;
}

export function screenOpenAnswer(title: string, index: number): string {
  return `${title} answer ${index}`;
}

function seedTurnConversation(store: RuntimeStore, projectId: string, title: string, turns: number): string {
  const conversation = store.createConversation(projectId, title);
  const prefix = title.toLowerCase().replace(/[^a-z]+/gu, "-");
  const baseTime = Date.now() - turns * 60_000;
  for (let index = 0; index < turns; index += 1) {
    const requestedAt = new Date(baseTime + index * 60_000).toISOString();
    const startedAt = new Date(baseTime + index * 60_000 + 250).toISOString();
    const completedAt = new Date(baseTime + index * 60_000 + 2_000).toISOString();
    const { turn } = store.beginAgentTurn({
      id: `${prefix}-turn-${String(index).padStart(3, "0")}`,
      conversationId: conversation.id,
      runId: `${prefix}-run-${index}`,
      content: `${title} request ${index}: inspect the durable transcript path and summarize the result.`,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "provider-default",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
      requestedAt,
    });
    store.updateAgentTurnLifecycle(turn.id, {
      status: "running",
      startedAt,
      updatedAt: startedAt,
    });
    if (index % 25 === 0) {
      const reasoning = store.createReasoning(conversation.id, turn.runId, turn.id);
      store.appendReasoningContent(reasoning.id, `Reasoning summary ${index}: preserve the ordered lifecycle.`);
      store.updateReasoning(reasoning.id, { status: "completed" });
      store.upsertAgentPlan({
        conversationId: conversation.id,
        runId: turn.runId,
        turnId: turn.id,
        explanation: `Plan for turn ${index}`,
        steps: [
          { step: "Persist the request", status: "completed" },
          { step: "Render the bounded timeline row", status: "completed" },
        ],
      });
    }
    if (index % 10 === 0) {
      store.addActivity({
        conversationId: conversation.id,
        runId: turn.runId,
        turnId: turn.id,
        kind: index % 20 === 0 ? "command" : "tool",
        title: `Measured activity ${index}`,
        detail: "Representative settled activity detail for long-session virtualization.",
        status: "completed",
        createdAt: completedAt,
      });
    }
    const answer = store.createMessage(
      conversation.id,
      [
        `## ${screenOpenAnswer(title, index)}`,
        "",
        "This answer is attached to a real authoritative turn and includes representative Markdown.",
        "",
        `- Durable request ${index} remains ordered.`,
        "- Settled heavy details stay behind their disclosure.",
        "",
        "```ts",
        `const measuredTurn = ${index};\nconst viewport = ".message-scroll";`,
        "```",
      ].join("\n"),
      "assistant",
      [],
      turn.id,
      completedAt,
    );
    store.settleAgentTurn(turn.id, {
      status: "completed",
      startedAt,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: "provider-completed",
    });
    if (index % 20 === 0) {
      store.createTurnGitArtifact({
        id: `${prefix}-artifact-${index}`,
        turnId: turn.id,
        branch: "main",
        createdAt: completedAt,
      });
      store.completeTurnGitArtifact(turn.id, {
        files: [{
          path: `src/screen-open-fixture-${index}.ts`,
          previousPath: null,
          status: "M",
          insertions: 4,
          deletions: 1,
          untracked: false,
          staged: false,
          unstaged: true,
          indexStatus: " ",
          worktreeStatus: "M",
          binary: false,
        }],
        insertions: 4,
        deletions: 1,
        status: "ready",
        completeness: "complete",
        patchState: "none",
        capturedAt: completedAt,
        terminalAssistantMessageId: answer.id,
        updatedAt: completedAt,
      });
    }
  }
  return conversation.id;
}

function seedShortConversation(store: RuntimeStore, projectId: string, title: string, count: number): string {
  const conversation = store.createConversation(projectId, title);
  for (let index = 0; index < count; index += 1) {
    store.createMessage(
      conversation.id,
      `${title} message ${index}: ${"y".repeat(128)}`,
      index % 2 === 0 ? "user" : "assistant",
    );
  }
  return conversation.id;
}

export function seedScreenOpenFixture(testDirectory: string, workspaceDirectory: string): ScreenOpenSeed {
  const store = new RuntimeStore(
    join(testDirectory, "data", "inertia.sqlite"),
    workspaceDirectory,
    { recoverInterruptedRuns: false },
  );
  try {
    const snapshot = store.shellSnapshot();
    const projects = snapshot.projects.filter((project) => project.workspaceKind !== "scratch");
    const primary = projects.find((project) => project.name === "Inertia") ?? projects[0];
    if (!primary) throw new Error("The screen-open fixture has no seeded project.");
    const home = snapshot.conversations.find((conversation) => conversation.projectId === primary.id);
    if (!home) throw new Error("The screen-open fixture has no seeded home chat.");
    const longConversationId = seedTurnConversation(store, primary.id, SCREEN_OPEN_LONG_CHAT, SCREEN_OPEN_LONG_TURNS);
    const shortConversationId = seedTurnConversation(store, primary.id, SCREEN_OPEN_SHORT_CHAT, SCREEN_OPEN_SHORT_TURNS);
    for (let index = 0; index < SCREEN_OPEN_EXTRA_CHATS; index += 1) {
      const project = projects[index % projects.length]!;
      seedShortConversation(store, project.id, `Background chat ${index + 1}`, 6);
    }
    store.selectConversation(home.id);
    return {
      homeConversationId: home.id,
      longConversationId,
      shortConversationId,
    };
  } finally {
    store.close();
  }
}
