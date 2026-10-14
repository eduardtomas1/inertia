import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../src/server/database";

const execFileAsync = promisify(execFile);

export interface StartupSeedShape {
  longChatTurns: number;
  projects: number;
  shortChatsPerProject: number;
  shortChatMessages: number;
}

export interface StartupSeedSummary extends StartupSeedShape {
  longChatId: string;
  conversations: number;
  messages: number;
}

export async function initializeStartupWorkspace(workspace: string, name: string): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await Promise.all(Array.from({ length: 40 }, async (_, index) => {
    await writeFile(
      join(workspace, "src", `module-${String(index).padStart(3, "0")}.ts`),
      `export const ${name.replace(/\W/gu, "_")}${index} = ${index};\n`,
    );
  }));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", [
    "-c", "user.name=Inertia Startup Profile",
    "-c", "user.email=startup@inertia.local",
    "commit", "-qm", "fixture",
  ], { cwd: workspace });
}

function seedLongChat(store: RuntimeStore, conversationId: string, turns: number): number {
  const baseTime = Date.now() - turns * 60_000 - 3_600_000;
  let messages = 0;
  for (let index = 0; index < turns; index += 1) {
    const requestedAt = new Date(baseTime + index * 60_000).toISOString();
    const startedAt = new Date(baseTime + index * 60_000 + 250).toISOString();
    const completedAt = new Date(baseTime + index * 60_000 + 2_000).toISOString();
    const { turn } = store.beginAgentTurn({
      id: `startup-long-turn-${String(index).padStart(5, "0")}`,
      conversationId,
      runId: `startup-long-run-${index}`,
      content: `Request ${index}: inspect the module, explain the change, and keep the summary short.`,
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
    messages += 1;
    store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt, updatedAt: startedAt });
    if (index % 25 === 0) {
      const reasoning = store.createReasoning(conversationId, turn.runId, turn.id);
      store.appendReasoningContent(reasoning.id, `Reasoning ${index}: compare the two approaches and keep the order.`);
      store.updateReasoning(reasoning.id, { status: "completed" });
      store.upsertAgentPlan({
        conversationId,
        runId: turn.runId,
        turnId: turn.id,
        explanation: `Plan ${index}`,
        steps: [
          { step: "Read the module", status: "completed" },
          { step: "Apply the change", status: "completed" },
        ],
      });
    }
    if (index % 10 === 0) {
      store.addActivity({
        conversationId,
        runId: turn.runId,
        turnId: turn.id,
        kind: index % 20 === 0 ? "command" : "tool",
        title: `Activity ${index}`,
        detail: "Settled activity detail.",
        status: "completed",
        createdAt: completedAt,
      });
    }
    const answer = store.createMessage(
      conversationId,
      [
        `## Answer ${index}`,
        "",
        "The change keeps the module small and adds one focused test.",
        "",
        `- Item ${index} stays ordered.`,
        "- The detail stays behind its disclosure.",
        "",
        "```ts",
        `export const answer${index} = ${index};`,
        "```",
      ].join("\n"),
      "assistant",
      [],
      turn.id,
      completedAt,
    );
    messages += 1;
    store.settleAgentTurn(turn.id, {
      status: "completed",
      startedAt,
      completedAt,
      updatedAt: completedAt,
      terminalAssistantMessageId: answer.id,
      terminalReason: "provider-completed",
    });
  }
  return messages;
}

export function seedStartupDatabase(
  dataDirectory: string,
  workspaces: readonly string[],
  shape: StartupSeedShape,
): StartupSeedSummary {
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspaces[0]!, {
    recoverInterruptedRuns: false,
  });
  let conversations = 0;
  let messages = 0;
  let longChatId = "";
  try {
    for (let projectIndex = 0; projectIndex < shape.projects; projectIndex += 1) {
      const project = store.createProject(`Startup project ${projectIndex + 1}`, workspaces[projectIndex]!);
      for (let chatIndex = 0; chatIndex < shape.shortChatsPerProject; chatIndex += 1) {
        const chat = store.createConversation(project.id, `Chat ${projectIndex + 1}.${chatIndex + 1}`);
        conversations += 1;
        for (let messageIndex = 0; messageIndex < shape.shortChatMessages; messageIndex += 1) {
          store.createMessage(
            chat.id,
            `Message ${messageIndex}: ${"short chat text ".repeat(6)}`,
            messageIndex % 2 === 0 ? "user" : "assistant",
          );
          messages += 1;
        }
      }
      if (projectIndex === 0) {
        const longChat = store.createConversation(project.id, "Long chat");
        conversations += 1;
        longChatId = longChat.id;
        messages += seedLongChat(store, longChat.id, shape.longChatTurns);
      }
    }
    store.selectConversation(longChatId);
  } finally {
    store.close();
  }
  return { ...shape, longChatId, conversations, messages };
}
