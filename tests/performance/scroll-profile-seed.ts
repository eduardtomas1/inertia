import { createCanvas } from "@napi-rs/canvas";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeStore } from "../../src/server/database";

export interface ScrollProfileSeed {
  primaryId: string;
  sidebarConversations: number;
}

function answerMarkdown(index: number): string {
  const paragraphs = [
    `The durable transcript path for request ${index} keeps every lifecycle record ordered, and the projection rebuilds the visible row from the persisted turn rather than from transient provider state. That keeps a restart, a reconnect, and a detached window identical.`,
    `I inspected the renderer boundary next. The virtual window measures each mounted row after commit, so a row whose height differs from its estimate moves every following row once. Rows that are already measured keep their cached size and are not measured again unless their content changes.`,
    `Finally, the settled work log is consolidated behind its disclosure so that **${index % 3 === 0 ? "large command output" : "routine tool activity"}** does not inflate the default reading view, and \`ResponseTimeline\` only mounts what the reader can see plus a small overscan.`,
  ];
  const parts = [
    `## Result for request ${index}`,
    "",
    ...paragraphs.flatMap((paragraph) => [paragraph, ""]),
    "### Changes",
    "",
    ...Array.from({ length: 6 }, (_, item) => `- Item ${item + 1} for request ${index}: updated \`src/module-${String((index + item) % 120).padStart(3, "0")}.ts\` and its focused test.`),
    "",
  ];
  if (index % 4 === 0) {
    parts.push(
      "| File | Insertions | Deletions | Status |",
      "| --- | ---: | ---: | --- |",
      ...Array.from({ length: 5 }, (_, row) => `| src/module-${String((index + row) % 120).padStart(3, "0")}.ts | ${row * 3 + 1} | ${row} | modified |`),
      "",
    );
  }
  if (index % 2 === 0) {
    parts.push(
      "```ts",
      ...Array.from({ length: 25 }, (_, line) => line % 5 === 0
        ? `export async function measuredStep${index}_${line}(input: ReadonlyArray<string>): Promise<number> {`
        : line % 5 === 4
          ? "}"
          : `  const value${line} = input.filter((entry) => entry.length > ${line}).map((entry) => entry.trim()).length + ${index};`),
      "```",
      "",
    );
  }
  if (index % 3 === 0) {
    parts.push(
      "```bash",
      "npm run build:bundle",
      `npm test -- tests/unit/module-${index % 120}.test.ts`,
      "git status --short",
      "git diff --stat",
      "```",
      "",
    );
  }
  if (index % 5 === 0) {
    parts.push(
      "```json",
      JSON.stringify({ request: index, files: [index % 120, (index + 1) % 120], settled: true, durationMs: 1200 + index }, null, 2),
      "```",
      "",
    );
  }
  parts.push(`That completes request ${index}; the next request can rely on the same ordered history.`);
  return parts.join("\n");
}

function userPrompt(index: number): string {
  if (index % 7 !== 0) return `Request ${index}: inspect the durable transcript path and summarize the result.`;
  return [
    `Request ${index}: here is the longer context for this step.`,
    "",
    "The reader reported that scrolling back through a long chat feels heavy. Please look at the transcript virtualization, the markdown renderer, and the code highlighting, and describe where the time goes before changing anything.",
    "",
    "Keep the explanation short and list the files you touched.",
  ].join("\n");
}

function commandOutput(index: number): string {
  return Array.from({ length: 20 }, (_, line) => `[${String(line).padStart(2, "0")}] ok src/module-${String((index + line) % 120).padStart(3, "0")}.ts (${(line * 7) % 40}ms)`).join("\n");
}

async function imageBytes(index: number): Promise<Buffer> {
  const canvas = createCanvas(960, 600);
  const context = canvas.getContext("2d");
  const gradient = context.createLinearGradient(0, 0, 960, 600);
  gradient.addColorStop(0, `hsl(${(index * 37) % 360}, 70%, 45%)`);
  gradient.addColorStop(1, `hsl(${(index * 37 + 120) % 360}, 70%, 65%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 960, 600);
  for (let stripe = 0; stripe < 40; stripe += 1) {
    context.fillStyle = `hsla(${(stripe * 17 + index) % 360}, 60%, 50%, 0.35)`;
    context.fillRect(stripe * 24, (stripe * 53) % 600, 18, 120);
  }
  return canvas.toBuffer("image/png");
}

export async function seedTranscript(
  store: RuntimeStore,
  files: ConversationAttachmentStore,
  conversationId: string,
  rows: number,
): Promise<void> {
  const baseTime = Date.now() - (rows + 5) * 60_000;
  for (let index = 0; index < rows; index += 1) {
    const requestedAt = new Date(baseTime + index * 60_000).toISOString();
    const startedAt = new Date(baseTime + index * 60_000 + 250).toISOString();
    const completedAt = new Date(baseTime + index * 60_000 + 2_000).toISOString();
    const attachments = index % 50 === 25
      ? await (async () => {
          const id = randomUUID();
          const bytes = await imageBytes(index);
          return await files.retain([{
            attachment: { id, path: id, name: `screenshot-${index}.png`, mimeType: "image/png", size: bytes.length },
            bytes,
          }]);
        })()
      : [];
    const { turn } = store.beginAgentTurn({
      id: `scroll-profile-turn-${String(index).padStart(4, "0")}`,
      conversationId,
      runId: `scroll-profile-run-${index}`,
      content: userPrompt(index),
      attachments,
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
    store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt, updatedAt: startedAt });
    if (index % 5 === 0) {
      const reasoning = store.createReasoning(conversationId, turn.runId, turn.id);
      store.appendReasoningContent(reasoning.id, `Reasoning ${index}: compare the measured row heights with their estimates, then check which rows mount during a fast scroll.`);
      store.updateReasoning(reasoning.id, { status: "completed" });
    }
    if (index % 25 === 0) {
      store.upsertAgentPlan({
        conversationId,
        runId: turn.runId,
        turnId: turn.id,
        explanation: `Plan for request ${index}`,
        steps: [
          { step: "Read the transcript path", status: "completed" },
          { step: "Measure the virtual window", status: "completed" },
          { step: "Summarize the result", status: "completed" },
        ],
      });
    }
    const activityCount = index % 3 === 0 ? 6 : 2;
    for (let activity = 0; activity < activityCount; activity += 1) {
      const kind = activity % 3 === 0 ? "command" : activity % 3 === 1 ? "tool" : "file";
      store.addActivity({
        conversationId,
        runId: turn.runId,
        turnId: turn.id,
        kind,
        title: kind === "command"
          ? `npm test -- tests/unit/module-${(index + activity) % 120}.test.ts`
          : kind === "tool"
            ? `Read src/module-${String((index + activity) % 120).padStart(3, "0")}.ts`
            : `Edited src/module-${String((index + activity) % 120).padStart(3, "0")}.ts`,
        detail: kind === "command" ? commandOutput(index + activity) : `Representative ${kind} detail ${index}.${activity}`,
        status: "completed",
        createdAt: completedAt,
      });
    }
    const answer = store.createMessage(conversationId, answerMarkdown(index), "assistant", [], turn.id, completedAt);
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
        id: `scroll-profile-artifact-${index}`,
        turnId: turn.id,
        branch: "main",
        createdAt: completedAt,
      });
      store.completeTurnGitArtifact(turn.id, {
        files: [{
          path: `src/module-${String(index % 120).padStart(3, "0")}.ts`,
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
}

export async function seedScrollProfile(
  dataDirectory: string,
  workspace: string,
  options: { rows: number; sidebarConversations: number; sidebarProjects: number },
): Promise<ScrollProfileSeed> {
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
  const files = await ConversationAttachmentStore.open(dataDirectory);
  try {
    store.updateSettings({ autoScrollToFinalAnswer: false });
    const project = store.createProject("Scroll profile", workspace);
    const primary = store.createConversation(project.id, "Scroll profile primary");
    await seedTranscript(store, files, primary.id, options.rows);
    const projects = [project];
    for (let index = 1; index < options.sidebarProjects; index += 1) {
      const directory = join(workspace, "projects", `project-${index}`);
      await mkdir(directory, { recursive: true });
      projects.push(store.createProject(`Project ${index}`, directory));
    }
    for (let index = 0; index < options.sidebarConversations; index += 1) {
      const owner = projects[index % projects.length]!;
      const conversation = store.createConversation(owner.id, `Sidebar chat ${index}: ${["fix flaky test", "review diff", "update docs", "profile scrolling", "triage issue"][index % 5]}`);
      store.createMessage(conversation.id, `Sidebar chat ${index} request`, "user");
      store.createMessage(conversation.id, `Sidebar chat ${index} answer`, "assistant");
    }
    store.selectConversation(primary.id);
    return { primaryId: primary.id, sidebarConversations: options.sidebarConversations };
  } finally {
    store.close();
    await files.close();
  }
}
