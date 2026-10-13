import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";

import type { ChatAttachment } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";

const execFileAsync = promisify(execFile);

export const CONTENT_LOADING_CHAT_MESSAGES = [50, 300, 2_000] as const;
export type ContentLoadingChatSize = typeof CONTENT_LOADING_CHAT_MESSAGES[number];

export interface ContentLoadingFixture {
  projectId: string;
  chats: Record<ContentLoadingChatSize, { id: string; title: string; turns: number; lastAnswerMarker: string; rowPrefix: string }>;
  fillerChatCount: number;
  archivedChatCount: number;
  imageCount: number;
}

export interface ContentLoadingFixtureOptions {
  fillerChats?: number;
  archivedChats?: number;
  images?: boolean;
}

const BIG_OUTPUT_CHARS = 32 * 1024;
const TURN_SPACING_MS = 5_000;
const CHAT_SPACING_MS = 60_000;

function png(width: number, height: number, seed: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  let state = seed | 1;
  for (let y = 0; y < height; y += 1) {
    const offset = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const pixel = offset + 1 + x * 3;
      rows[pixel] = (x * 255 / width + (state & 31)) & 255;
      rows[pixel + 1] = (y * 255 / height + ((state >> 5) & 31)) & 255;
      rows[pixel + 2] = (seed * 37 + ((state >> 10) & 63)) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function words(seed: number, count: number): string {
  const vocabulary = ["renderer", "runtime", "transcript", "history", "virtualized", "projection", "commit",
    "provider", "workspace", "snapshot", "conversation", "measured", "boundary", "durable", "latency",
    "SQLite", "WebSocket", "payload", "markdown", "viewport", "cursor", "page", "turn", "activity"];
  let state = seed * 2_654_435_761 >>> 0 || 1;
  return Array.from({ length: count }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return vocabulary[(state >>> 0) % vocabulary.length];
  }).join(" ");
}

function commandOutput(index: number, chars: number): string {
  const lines: string[] = [];
  let line = 0;
  while (lines.join("\n").length < chars) {
    lines.push(line % 9 === 0
      ? ` ✓ tests/server/module-${index}-${line}.test.ts (${(line * 7) % 40} tests) ${(line * 13) % 900}ms`
      : `   at src/server/persistence/repository-${line % 17}.ts:${(line * 31) % 400}:${line % 60} ${words(index * 1_000 + line, 6)}`);
    line += 1;
  }
  return lines.join("\n").slice(0, chars);
}

function fileExcerpt(index: number): string {
  return Array.from({ length: 24 }, (_, line) =>
    `${String(line + 1).padStart(4)}\texport function step${index}_${line}(input: string): string { return input.trim(); }`)
    .join("\n").slice(0, 2_400);
}

function answer(index: number, marker: string): string {
  const table = index % 5 === 0 ? [
    "",
    "| Stage | Before | After |",
    "| --- | ---: | ---: |",
    `| Query | ${index % 90} ms | ${index % 30} ms |`,
    `| Render | ${index % 70} ms | ${index % 20} ms |`,
  ] : [];
  return [
    `## ${marker}`,
    "",
    words(index, 60),
    "",
    `- ${words(index + 1, 12)}`,
    `- ${words(index + 2, 10)}`,
    `- \`src/renderer/src/components/module-${index % 40}.tsx\` ${words(index + 3, 8)}`,
    ...table,
    "",
    "```ts",
    ...Array.from({ length: 18 }, (_, line) =>
      `const value${line} = await load${index % 7}({ page: ${line}, cursor: "${index}-${line}" });`),
    "```",
    "",
    words(index + 4, 40),
  ].join("\n");
}

export async function initializeContentLoadingWorkspace(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src"), { recursive: true });
  await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(
    join(workspace, "src", `module-${String(index).padStart(3, "0")}.ts`),
    `export const value = ${index};\n`,
  )));
  await execFileAsync("git", ["init", "-q"], { cwd: workspace });
  await execFileAsync("git", ["add", "."], { cwd: workspace });
  await execFileAsync("git", ["-c", "user.name=Inertia Benchmark", "-c", "user.email=benchmark@inertia.local",
    "commit", "-qm", "fixture"], { cwd: workspace });
}

function seedChat(
  store: RuntimeStore,
  projectId: string,
  title: string,
  turns: number,
  baseTime: number,
  imageTurns: Map<number, ChatAttachment>,
  prefix: string,
): { id: string; lastAnswerMarker: string } {
  const conversation = store.createConversation(projectId, title);
  let lastAnswerMarker = "";
  for (let index = 0; index < turns; index += 1) {
    const at = (offset: number) => new Date(baseTime + index * TURN_SPACING_MS + offset).toISOString();
    const attachment = imageTurns.get(index);
    const { turn } = store.beginAgentTurn({
      id: `${prefix}-turn-${String(index).padStart(4, "0")}`,
      conversationId: conversation.id,
      runId: `${prefix}-run-${index}`,
      content: `Request ${index}: ${words(index + 7, 30)}`,
      ...(attachment ? { attachments: [attachment] } : {}),
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "provider-default",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
      requestedAt: at(0),
      activateConversation: false,
    });
    store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: at(250), updatedAt: at(250) });
    if (index % 4 === 0) {
      const reasoning = store.createReasoning(conversation.id, turn.runId, turn.id);
      store.appendReasoningContent(reasoning.id, words(index + 11, 140));
      store.updateReasoning(reasoning.id, { status: "completed" });
    }
    store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id, kind: "tool",
      title: `Read src/server/module-${index % 40}.ts`, detail: fileExcerpt(index), status: "completed", createdAt: at(500) });
    store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id, kind: "command",
      title: "npm test -- tests/server", detail: commandOutput(index, 3_000), status: "completed", createdAt: at(700) });
    if (index % 8 === 0) {
      store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id, kind: "command",
        title: "npm run check", detail: commandOutput(index + 1, BIG_OUTPUT_CHARS), status: "completed", createdAt: at(900) });
    }
    if (index % 25 === 0) {
      store.upsertAgentPlan({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
        explanation: `Plan ${index}`, steps: [
          { step: "Read the module", status: "completed" },
          { step: "Change the module", status: "completed" },
          { step: "Run the tests", status: "completed" },
        ] });
    }
    lastAnswerMarker = `${prefix} answer ${index}`;
    const message = store.createMessage(conversation.id, answer(index, lastAnswerMarker), "assistant", [], turn.id, at(2_000));
    store.settleAgentTurn(turn.id, { status: "completed", startedAt: at(250), completedAt: at(2_000), updatedAt: at(2_000),
      terminalAssistantMessageId: message.id, terminalReason: "provider-completed" });
  }
  return { id: conversation.id, lastAnswerMarker };
}

export async function seedContentLoadingRuntime(
  dataDirectory: string,
  workspace: string,
  options: ContentLoadingFixtureOptions = {},
): Promise<ContentLoadingFixture> {
  const fillerChats = options.fillerChats ?? 30;
  const archivedChats = options.archivedChats ?? 120;
  await mkdir(dataDirectory, { recursive: true });
  const imagesByChat = new Map<ContentLoadingChatSize, Map<number, ChatAttachment>>();
  let imageCount = 0;
  if (options.images !== false) {
    const attachments = await ConversationAttachmentStore.open(dataDirectory);
    try {
      for (const size of CONTENT_LOADING_CHAT_MESSAGES) {
        const turns = size / 2;
        const map = new Map<number, ChatAttachment>();
        for (const turnIndex of [1, Math.floor(turns / 2), turns - 2]) {
          const bytes = png(480, 320, size + turnIndex);
          const path = join(dataDirectory, `seed-${size}-${turnIndex}.png`);
          await writeFile(path, bytes);
          const retentionId = randomUUID();
          const [retained] = await attachments.retain([{ attachment: { id: randomUUID(),
            name: `screenshot-${turnIndex}.png`, path, mimeType: "image/png", size: bytes.length }, bytes }],
          undefined, retentionId);
          attachments.acceptRetention(retentionId);
          map.set(turnIndex, retained!);
          imageCount += 1;
        }
        imagesByChat.set(size, map);
      }
    } finally {
      await attachments.close();
    }
  }
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
  try {
    store.updateSettings({ autoScrollToFinalAnswer: false });
    const project = store.createProject("Content loading fixture", workspace);
    const baseTime = Date.now() - 5 * 60 * 60_000;
    for (let index = 0; index < archivedChats; index += 1) {
      const chat = seedChat(store, project.id, `Archived chat ${index}`, 5, baseTime + index * CHAT_SPACING_MS, new Map(), `archived-${index}`);
      store.archiveConversation(chat.id, true);
    }
    for (let index = 0; index < fillerChats; index += 1) {
      seedChat(store, project.id, `Filler chat ${index}`, 3, baseTime + (archivedChats + index) * CHAT_SPACING_MS, new Map(), `filler-${index}`);
    }
    const chats = {} as ContentLoadingFixture["chats"];
    let offset = (archivedChats + fillerChats) * CHAT_SPACING_MS;
    for (const size of CONTENT_LOADING_CHAT_MESSAGES) {
      const turns = size / 2;
      const title = `History ${size} messages`;
      const chat = seedChat(store, project.id, title, turns, baseTime + offset, imagesByChat.get(size) ?? new Map(), `history-${size}`);
      offset += turns * TURN_SPACING_MS + CHAT_SPACING_MS;
      chats[size] = { id: chat.id, title, turns, lastAnswerMarker: chat.lastAnswerMarker, rowPrefix: `history-${size} answer ` };
    }
    store.selectConversation(chats[50].id);
    return { projectId: project.id, chats, fillerChatCount: fillerChats, archivedChatCount: archivedChats, imageCount };
  } finally {
    store.close();
  }
}
