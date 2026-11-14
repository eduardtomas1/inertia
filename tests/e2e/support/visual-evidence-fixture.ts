import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import Database from "better-sqlite3";

import { RuntimeStore } from "../../../src/server/database";
import type { AgentApprovalRequest, AgentInputRequest, ProviderId } from "../../../src/shared/contracts";
import { continuationIdentityForSelection, providerNativeModelSelection } from "../../../src/shared/model-routing";

const execFileAsync = promisify(execFile);

export const VISUAL_FIXED_NOW = Date.parse("2026-10-03T10:30:00.000Z");

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const VISUAL_TITLES = {
  welcome: "New chat",
  running: "Refine the response timeline",
  finished: "Document the export format",
  handoff: "Tighten the release checklist",
  approval: "Run the migration verification",
  question: "Choose the invoice export layout",
  failed: "Rotate the webhook signing keys",
  multi: "Migrate invoices to the new schema",
  yesterday: "Fix broken anchor links",
  threeDays: "Write the theming guide",
  sixDays: "Audit image alt text",
} as const;

export type VisualChat = keyof typeof VISUAL_TITLES;

export interface VisualSeed {
  conversations: Record<VisualChat, string>;
  turns: {
    running: { id: string; runId: string };
    finished: { id: string };
    approval: { id: string; runId: string };
    question: { id: string; runId: string };
  };
  approvalRequest: AgentApprovalRequest;
  inputRequest: AgentInputRequest;
}

function at(offset: number): string {
  return new Date(VISUAL_FIXED_NOW - offset).toISOString();
}

export const visualCodexAppServerSource = `
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "visual-evidence-fixture" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    send({ id: message.id, result: { data: [
      {
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        description: "Agentic coding model for complex engineering work.",
        isDefault: true,
        inputModalities: ["text", "image"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast responses" },
          { reasoningEffort: "medium", description: "Balanced reasoning" },
          { reasoningEffort: "high", description: "Deep reasoning" }
        ]
      },
      {
        model: "gpt-5.2-codex-mini",
        displayName: "GPT-5.2 Codex Mini",
        description: "Fast, efficient coding model for everyday tasks.",
        inputModalities: ["text"],
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: [
          { reasoningEffort: "medium", description: "Balanced reasoning" }
        ]
      }
    ], nextCursor: null } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "Not available in the visual fixture" } });
  }
});
`;

export const visualClaudeAuthSource = `
if (process.argv[2] === "status") {
  process.stdout.write(JSON.stringify({ loggedIn: false }) + "\\n");
  process.exit(1);
}
`;

const FINISHED_ANSWER = [
  "The export format is now documented in `docs/export-format.md`, and the exporter validates every record against it before writing. The timeline in `src/renderer/src/components/ResponseTimeline.tsx` links to it, the new check lives in `tests/renderer/response-timeline.test.ts:42`, and the `export` script is registered in `package.json`.",
  "",
  "## What changed",
  "",
  "The exporter used to write whatever the invoice query returned. It now builds each record from a typed schema, so a missing field fails the export instead of producing a silent gap.",
  "",
  "### Record layout",
  "",
  "| Field | Type | Required | Notes |",
  "| --- | --- | --- | --- |",
  "| `invoiceId` | string | Yes | Stable across exports |",
  "| `issuedAt` | ISO 8601 date | Yes | Always UTC |",
  "| `total` | integer | Yes | Minor units, never floats |",
  "| `currency` | ISO 4217 code | Yes | Upper case |",
  "| `memo` | string | No | Trimmed to 280 characters |",
  "",
  "### Validation",
  "",
  "```ts",
  "export function validateRecord(record: ExportRecord): ExportIssue[] {",
  "  const issues: ExportIssue[] = [];",
  "  if (!Number.isInteger(record.total)) {",
  "    issues.push({ field: \"total\", reason: \"Totals are stored in minor units.\" });",
  "  }",
  "  if (!/^[A-Z]{3}$/u.test(record.currency)) {",
  "    issues.push({ field: \"currency\", reason: \"Use an upper-case ISO 4217 code.\" });",
  "  }",
  "  return issues;",
  "}",
  "```",
  "",
  "## How to verify",
  "",
  "1. Run `npm run export -- --dry-run` against the staging snapshot.",
  "2. Open the generated `exports/invoices.jsonl` and spot-check three records.",
  "3. Run `npm test -- export` to confirm the schema tests pass.",
  "4. Compare the record count with the invoice table; they should match exactly.",
  "",
  "The old CSV exporter is untouched, so downstream jobs keep working until they move to the new format.",
].join("\n");

function selection(providerId: ProviderId, modelId: string) {
  return providerNativeModelSelection({ providerId, modelId, reasoningEffort: "medium" });
}

export async function prepareVisualWorkspaces(input: {
  testDirectory: string;
  workspaceDirectory: string;
}): Promise<{ billingDirectory: string; docsDirectory: string }> {
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: input.workspaceDirectory });
  await writeFile(join(input.workspaceDirectory, "src", "components", "Button.tsx"), [
    "import type { ReactNode } from \"react\";",
    "",
    "export interface ButtonProps {",
    "  children: ReactNode;",
    "  tone?: \"default\" | \"quiet\";",
    "  onPress?: () => void;",
    "}",
    "",
    "export const Button = ({ children, tone = \"default\", onPress }: ButtonProps) => (",
    "  <button type=\"button\" data-tone={tone} onClick={onPress}>",
    "    {children}",
    "  </button>",
    ");",
    "",
  ].join("\n"), "utf8");
  await writeFile(join(input.workspaceDirectory, "docs", "guide.md"), [
    "# Guide",
    "",
    "Buttons take a `tone` so quiet actions stay quiet.",
    "",
  ].join("\n"), "utf8");
  const billingDirectory = join(input.testDirectory, "projects", "billing-service");
  const docsDirectory = join(input.testDirectory, "projects", "docs-site");
  await mkdir(billingDirectory, { recursive: true });
  await mkdir(docsDirectory, { recursive: true });
  return { billingDirectory, docsDirectory };
}

interface TurnSeed {
  id: string;
  conversationId: string;
  prompt: string;
  providerId?: ProviderId;
  modelId?: string;
  requestedAt: number;
  sessionRecovery?: { restoredMessageCount: number; omittedMessageCount: number };
}

function beginTurn(store: RuntimeStore, seed: TurnSeed) {
  const providerId = seed.providerId ?? "codex";
  const modelSelection = selection(providerId, seed.modelId ?? "gpt-5.3-codex");
  store.updateConversation(seed.conversationId, { providerId, modelSelection });
  const requestedAt = at(seed.requestedAt);
  const startedAt = at(seed.requestedAt - 2 * SECOND);
  const { turn } = store.beginAgentTurn({
    id: `visual-${seed.id}`,
    conversationId: seed.conversationId,
    runId: `visual-${seed.id}-run`,
    content: seed.prompt,
    providerId,
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection),
    ...(seed.sessionRecovery
      ? { continuationReasonCode: "harness-changed" as const, sessionRecovery: seed.sessionRecovery }
      : {}),
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt,
  });
  store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt, updatedAt: startedAt });
  return { turn, startedAt: seed.requestedAt - 2 * SECOND };
}

function settleTurn(
  store: RuntimeStore,
  conversationId: string,
  begun: ReturnType<typeof beginTurn>,
  answer: string,
  durationMs: number,
  status: "completed" | "failed" = "completed",
  files: Array<{ path: string; insertions: number; deletions: number; status?: string }> = [],
) {
  const completedAt = at(begun.startedAt - durationMs);
  const message = store.createMessage(conversationId, answer, "assistant", [], begun.turn.id, completedAt);
  store.updateAgentTurnLifecycle(begun.turn.id, {
    status,
    completedAt,
    updatedAt: completedAt,
    terminalAssistantMessageId: message.id,
    terminalReason: status === "completed" ? "provider-completed" : "provider-failed",
  });
  store.updateConversation(conversationId, { status });
  store.createTurnGitArtifact({ id: `${begun.turn.id}-artifact`, turnId: begun.turn.id, branch: "main", createdAt: completedAt });
  store.completeTurnGitArtifact(begun.turn.id, {
    files: files.map((file) => ({
      path: file.path,
      previousPath: null,
      status: file.status ?? "M",
      insertions: file.insertions,
      deletions: file.deletions,
      untracked: false,
      staged: false,
      unstaged: true,
      indexStatus: " ",
      worktreeStatus: file.status ?? "M",
      binary: false,
    })),
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    status: "ready",
    completeness: "complete",
    patchState: "none",
    capturedAt: completedAt,
    terminalAssistantMessageId: message.id,
    updatedAt: completedAt,
  });
  return message;
}

function activity(
  store: RuntimeStore,
  conversationId: string,
  turn: { id: string; runId: string },
  offset: number,
  kind: "status" | "tool" | "command" | "file" | "error",
  title: string,
  status: "running" | "completed" | "failed" = "completed",
  detail: string | null = null,
) {
  return store.addActivity({
    conversationId,
    runId: turn.runId,
    turnId: turn.id,
    kind,
    title,
    detail,
    status,
    createdAt: at(offset),
  });
}

const traceDefaults = {
  providerTaskId: null,
  parentProviderAgentId: null,
  parentProviderToolUseId: null,
  providerToolUseId: null,
  providerRole: null,
  providerStatus: null,
  progress: null,
  result: null,
} as const;

/**
 * Seeds settled history before the application starts. Live turns are added
 * by {@link seedVisualLiveTurns} once the runtime is up, so startup recovery
 * cannot settle them.
 */
export function seedVisualHistory(input: {
  testDirectory: string;
  workspaceDirectory: string;
  billingDirectory: string;
  docsDirectory: string;
}): Omit<VisualSeed, "turns" | "approvalRequest" | "inputRequest"> & { turns: { finished: { id: string } } } {
  const store = new RuntimeStore(join(input.testDirectory, "data", "inertia.sqlite"), input.workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  const conversations = {} as Record<VisualChat, string>;
  let finishedTurnId = "";
  try {
    const snapshot = store.shellSnapshot();
    const inertia = snapshot.projects.find(({ name }) => name === "Inertia")!;
    const welcome = snapshot.conversations.find(({ projectId }) => projectId === inertia.id)!;
    store.updateConversation(welcome.id, { title: VISUAL_TITLES.welcome });
    conversations.welcome = welcome.id;
    const billing = store.createProject("billing-service", input.billingDirectory);
    const docs = store.createProject("docs-site", input.docsDirectory);
    const create = (chat: VisualChat, projectId: string) => {
      conversations[chat] = store.createConversation(projectId, VISUAL_TITLES[chat], { providerId: "codex" }).id;
      return conversations[chat];
    };
    for (const chat of ["running", "finished", "handoff"] as const) create(chat, inertia.id);
    for (const chat of ["approval", "question", "failed", "multi"] as const) create(chat, billing.id);
    for (const chat of ["yesterday", "threeDays", "sixDays"] as const) create(chat, docs.id);

    const finished = beginTurn(store, {
      id: "finished",
      conversationId: conversations.finished,
      prompt: "Document the invoice export format and make the exporter validate each record before it writes.",
      requestedAt: 9 * MINUTE,
    });
    finishedTurnId = finished.turn.id;
    activity(store, conversations.finished, finished.turn, 9 * MINUTE - 4 * SECOND, "command", "rg -n \"exportInvoices\" src");
    activity(store, conversations.finished, finished.turn, 9 * MINUTE - 7 * SECOND, "tool", "Read src/export/invoices.ts");
    activity(store, conversations.finished, finished.turn, 9 * MINUTE - 12 * SECOND, "file", "Edited src/export/schema.ts");
    activity(store, conversations.finished, finished.turn, 9 * MINUTE - 18 * SECOND, "file", "Created docs/export-format.md");
    activity(store, conversations.finished, finished.turn, 9 * MINUTE - 31 * SECOND, "command", "npm test -- export");
    for (const [index, trace] of [
      {
        providerAgentId: "visual-schema-reader",
        providerName: "Schema reader",
        providerRole: "explorer",
        description: "List every field the invoice query returns.",
        result: "Found 5 fields; memo is the only optional one.",
        model: "gpt-5.2-codex-mini",
        durationMs: 38 * SECOND,
      },
      {
        providerAgentId: "visual-test-writer",
        providerName: "Test writer",
        providerRole: "worker",
        description: "Write schema tests for missing and malformed fields.",
        result: "Added 6 tests; all pass.",
        model: "gpt-5.3-codex",
        durationMs: 64 * SECOND,
      },
    ].entries()) {
      store.upsertSubagentTrace({
        ...traceDefaults,
        ...trace,
        conversationId: conversations.finished,
        runId: finished.turn.runId,
        turnId: finished.turn.id,
        providerId: "codex",
        status: "completed",
        isLive: false,
        toolUseCount: 4 + index * 3,
        sequence: index + 1,
        updatedAt: at(9 * MINUTE - 20 * SECOND - index * 30 * SECOND),
      });
    }
    settleTurn(store, conversations.finished, finished, FINISHED_ANSWER, 2 * MINUTE + 14 * SECOND, "completed", [
      { path: "docs/export-format.md", insertions: 64, deletions: 0, status: "A" },
      { path: "src/export/schema.ts", insertions: 41, deletions: 6 },
      { path: "src/export/invoices.ts", insertions: 12, deletions: 9 },
      { path: "tests/export/schema.test.ts", insertions: 88, deletions: 0, status: "A" },
    ]);

    const claudeTurn = beginTurn(store, {
      id: "handoff-claude",
      conversationId: conversations.handoff,
      providerId: "claude",
      modelId: "claude-sonnet-4-6",
      prompt: "Draft a release checklist for the desktop app.",
      requestedAt: 2 * HOUR + 20 * MINUTE,
    });
    settleTurn(store, conversations.handoff, claudeTurn, [
      "Here is a first checklist:",
      "",
      "1. Verify the signing certificate is current.",
      "2. Run the package smoke test on every platform.",
      "3. Confirm the published checksums match the artifacts.",
    ].join("\n"), 48 * SECOND);
    const codexTurn = beginTurn(store, {
      id: "handoff-codex",
      conversationId: conversations.handoff,
      prompt: "Continue from that checklist and add the provenance step.",
      requestedAt: 2 * HOUR,
      sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 },
    });
    settleTurn(store, conversations.handoff, codexTurn, [
      "Added the provenance attestation right after the checksum step:",
      "",
      "4. Attach a build provenance attestation to each artifact and verify it with `gh attestation verify`.",
      "",
      "The rest of the checklist is unchanged.",
    ].join("\n"), 36 * SECOND, "completed", [{ path: "docs/RELEASING.md", insertions: 6, deletions: 1 }]);

    const failed = beginTurn(store, {
      id: "failed",
      conversationId: conversations.failed,
      prompt: "Rotate the webhook signing keys and re-sign the pending deliveries.",
      requestedAt: 26 * MINUTE,
    });
    activity(store, conversations.failed, failed.turn, 26 * MINUTE - 5 * SECOND, "tool", "Read config/webhooks.ts");
    activity(store, conversations.failed, failed.turn, 26 * MINUTE - 9 * SECOND, "command", "npm run keys:rotate -- --dry-run");
    activity(store, conversations.failed, failed.turn, 26 * MINUTE - 21 * SECOND, "command", "npm run keys:rotate", "failed", "The key store refused the write: permission denied.");
    activity(store, conversations.failed, failed.turn, 26 * MINUTE - 22 * SECOND, "error", "The provider stopped after the key rotation failed.", "failed", [
      "Reason: provider-failed",
      "Phase: running",
      "Exit code: 1",
      "Activity: npm run keys:rotate",
      "Cleanup: confirmed",
    ].join("\n"));
    settleTurn(store, conversations.failed, failed, "The rotation stopped before any key changed: the key store refused the write. Pending deliveries still use the current key.", 24 * SECOND, "failed");

    const multiPrompts = [
      ["Sketch how invoices move to the new billing schema without downtime.", "Move the tables behind a compatibility view first, then switch readers one at a time. The exporter keeps reading the view until the last step."],
      ["Write the migration for the invoice tables.", "Added `migrations/0042_invoice_schema.sql`. It creates the new tables, copies rows in batches of 5,000 and installs the compatibility view."],
      ["Check that the exporter still reads every invoice.", "The exporter reads all 18,204 invoices through the view, the same count as before the migration. Nothing downstream changed."],
    ] as const;
    multiPrompts.forEach(([prompt, answer], index) => {
      const turn = beginTurn(store, {
        id: `multi-${index + 1}`,
        conversationId: conversations.multi,
        prompt,
        requestedAt: 3 * HOUR + (2 - index) * 12 * MINUTE,
      });
      activity(store, conversations.multi, turn.turn, 3 * HOUR + (2 - index) * 12 * MINUTE - 6 * SECOND, "command", index === 2 ? "npm run export -- --count" : "rg -n invoice migrations");
      settleTurn(store, conversations.multi, turn, answer, (40 + index * 15) * SECOND, "completed",
        index === 1 ? [{ path: "migrations/0042_invoice_schema.sql", insertions: 58, deletions: 0, status: "A" }] : []);
    });

    for (const [chat, offset, prompt, answer] of [
      ["yesterday", DAY + 2 * HOUR, "Find and fix the broken anchor links in the guides.", "Fixed 7 anchors across 3 guides; the link checker is clean."],
      ["threeDays", 3 * DAY + HOUR, "Write a short theming guide for the docs site.", "Added `docs/theming.md` with the token list and two examples."],
      ["sixDays", 6 * DAY + 3 * HOUR, "Audit the image alt text on the landing pages.", "12 images had empty alt text; each now describes what it shows."],
    ] as const) {
      const turn = beginTurn(store, { id: chat, conversationId: conversations[chat], prompt, requestedAt: offset });
      settleTurn(store, conversations[chat], turn, answer, 52 * SECOND);
    }
    store.updateSettings({
      theme: "light",
      interfaceScale: "default",
      responseDensity: "default",
      showTimestamps: false,
      showThinking: true,
      autoCollapseWorkLog: true,
      showChangedFileSummaries: true,
      desktopNotifications: false,
    });
    store.selectConversation(conversations.finished);
  } finally {
    store.close();
  }
  const timestamps: Array<[VisualChat, number]> = [
    ["welcome", 30 * SECOND],
    ["finished", 9 * MINUTE - 2 * MINUTE - 16 * SECOND],
    ["failed", 26 * MINUTE - 26 * SECOND],
    ["handoff", 2 * HOUR - 38 * SECOND],
    ["multi", 3 * HOUR - 72 * SECOND],
    ["yesterday", DAY + 2 * HOUR - 54 * SECOND],
    ["threeDays", 3 * DAY + HOUR - 54 * SECOND],
    ["sixDays", 6 * DAY + 3 * HOUR - 54 * SECOND],
  ];
  pinConversationTimes(input.testDirectory, conversations, timestamps, ["welcome", "finished", "handoff", "multi", "yesterday", "threeDays", "sixDays"]);
  return { conversations, turns: { finished: { id: finishedTurnId } } };
}

function pinConversationTimes(
  testDirectory: string,
  conversations: Partial<Record<VisualChat, string>>,
  timestamps: ReadonlyArray<readonly [VisualChat, number]>,
  viewed: readonly VisualChat[],
): void {
  const database = new Database(join(testDirectory, "data", "inertia.sqlite"));
  try {
    const update = database.prepare("UPDATE conversations SET created_at = ?, updated_at = ?, last_viewed_at = ? WHERE id = ?");
    database.transaction(() => {
      for (const [chat, offset] of timestamps) {
        const id = conversations[chat];
        if (!id) continue;
        const value = at(offset);
        update.run(at(offset + 10 * MINUTE), value, viewed.includes(chat) ? value : null, id);
      }
    })();
  } finally {
    database.close();
  }
}

/**
 * Adds the running, approval and question turns to the running application's
 * database. The renderer reloads afterwards, so they appear as live work.
 */
export function seedVisualLiveTurns(input: {
  testDirectory: string;
  workspaceDirectory: string;
  conversations: Record<VisualChat, string>;
}): Pick<VisualSeed, "approvalRequest" | "inputRequest"> & {
  turns: Pick<VisualSeed["turns"], "running" | "approval" | "question">;
} {
  const { conversations } = input;
  const store = new RuntimeStore(join(input.testDirectory, "data", "inertia.sqlite"), input.workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  let reasoningId = "";
  try {
    const running = beginTurn(store, {
      id: "running",
      conversationId: conversations.running,
      prompt: "Refine the response timeline so long turns stay readable while they run, and keep me posted.",
      requestedAt: 3 * MINUTE + 12 * SECOND,
    });
    const base = 3 * MINUTE + 10 * SECOND;
    activity(store, conversations.running, running.turn, base - 2 * SECOND, "status", "Connected to the local runtime");
    store.createMessage(conversations.running,
      "I’m tracing how the timeline groups activity before changing anything, so the running view keeps its place.",
      "assistant", [], running.turn.id, at(base - 5 * SECOND));
    activity(store, conversations.running, running.turn, base - 8 * SECOND, "command", "rg -n \"ActivityGroup\" src/renderer");
    activity(store, conversations.running, running.turn, base - 11 * SECOND, "tool", "Read src/renderer/src/components/response-timeline/viewport.tsx");
    activity(store, conversations.running, running.turn, base - 15 * SECOND, "command", "npm run typecheck");
    store.createMessage(conversations.running,
      "The grouping is sound. I’m tightening the row spacing and asking a helper to map the scroll anchors while I edit.",
      "assistant", [], running.turn.id, at(base - 40 * SECOND));
    activity(store, conversations.running, running.turn, base - 44 * SECOND, "file", "Editing src/renderer/src/components/response-timeline/ActivityGroup.tsx", "running");
    activity(store, conversations.running, running.turn, base - 47 * SECOND, "command", "npx vitest run tests/renderer/response-timeline", "running");
    store.upsertSubagentTrace({
      ...traceDefaults,
      conversationId: conversations.running,
      runId: running.turn.runId,
      turnId: running.turn.id,
      providerId: "codex",
      providerAgentId: "visual-anchor-mapper",
      providerName: "Anchor mapper",
      providerRole: "explorer",
      description: "Map every scroll anchor the timeline restores after a re-render.",
      progress: "Reading the virtualized row cache",
      activity: "Reading src/renderer/src/components/response-timeline/viewport.tsx",
      model: "gpt-5.2-codex-mini",
      status: "running",
      isLive: true,
      toolUseCount: 6,
      sequence: 1,
      updatedAt: at(base - 50 * SECOND),
    });
    store.upsertSubagentTrace({
      ...traceDefaults,
      conversationId: conversations.running,
      runId: running.turn.runId,
      turnId: running.turn.id,
      providerId: "codex",
      providerAgentId: "visual-spacing-checker",
      providerName: "Spacing checker",
      providerRole: "reviewer",
      description: "Compare row spacing in the folded and open activity groups.",
      progress: "Measuring the group header heights",
      activity: "Running npx vitest run tests/renderer/activity-group.test.ts",
      model: "gpt-5.3-codex",
      status: "running",
      isLive: true,
      toolUseCount: 3,
      sequence: 2,
      updatedAt: at(base - 58 * SECOND),
    });
    const reasoning = store.createReasoning(conversations.running, running.turn.runId, running.turn.id);
    reasoningId = reasoning.id;
    store.updateReasoning(reasoning.id, {
      content: "Comparing the row heights before and after the change so the scroll position does not jump when a group folds.",
      status: "running",
    });
    store.updateConversation(conversations.running, { status: "running" });

    const approval = beginTurn(store, {
      id: "approval",
      conversationId: conversations.approval,
      prompt: "Run the migration verification against the staging snapshot.",
      requestedAt: 4 * MINUTE + 30 * SECOND,
    });
    activity(store, conversations.approval, approval.turn, 4 * MINUTE + 24 * SECOND, "tool", "Read migrations/0042_invoice_schema.sql");
    store.createMessage(conversations.approval,
      "The migration looks complete. Running the verification needs access to the staging snapshot, so I’m asking first.",
      "assistant", [], approval.turn.id, at(4 * MINUTE + 18 * SECOND));
    store.updateAgentTurnLifecycle(approval.turn.id, { status: "waiting-for-approval", updatedAt: at(4 * MINUTE + 15 * SECOND) });
    store.updateConversation(conversations.approval, { status: "needs-input", attentionKind: "approval" });

    const question = beginTurn(store, {
      id: "question",
      conversationId: conversations.question,
      prompt: "Lay out the invoice export screen.",
      requestedAt: 6 * MINUTE + 40 * SECOND,
    });
    activity(store, conversations.question, question.turn, 6 * MINUTE + 32 * SECOND, "tool", "Read src/screens/ExportScreen.tsx");
    store.updateAgentTurnLifecycle(question.turn.id, { status: "waiting-for-input", updatedAt: at(6 * MINUTE + 20 * SECOND) });
    store.updateConversation(conversations.question, { status: "needs-input", attentionKind: "input" });
    store.selectConversation(conversations.finished);

    const approvalRequest: AgentApprovalRequest = {
      id: "visual-approval-request",
      providerId: "codex",
      conversationId: conversations.approval,
      runId: approval.turn.runId,
      turnId: approval.turn.id,
      kind: "command",
      title: "Run the migration verification",
      detail: "Reads the staging snapshot and compares row counts; nothing is written.",
      command: "npm run migrate:verify -- --snapshot staging",
      cwd: null,
      reason: "The supervised command needs your approval before it runs.",
      networkScope: null,
      permissionRoots: [],
      availableDecisions: ["cancel", "deny", "approve"],
    };
    const inputRequest: AgentInputRequest = {
      id: "visual-input-request",
      providerId: "codex",
      conversationId: conversations.question,
      runId: question.turn.runId,
      turnId: question.turn.id,
      autoResolutionMs: null,
      questions: [{
        id: "visual-layout",
        header: "Layout",
        question: "Which layout should the export screen use?",
        isOther: true,
        isSecret: false,
        allowMultiple: false,
        options: [
          { id: "table", label: "Table", description: "One row per invoice, sortable columns." },
          { id: "cards", label: "Cards", description: "One card per invoice with the total first." },
        ],
      }],
    };
    return {
      turns: {
        running: { id: running.turn.id, runId: running.turn.runId },
        approval: { id: approval.turn.id, runId: approval.turn.runId },
        question: { id: question.turn.id, runId: question.turn.runId },
      },
      approvalRequest,
      inputRequest,
    };
  } finally {
    store.close();
    const database = new Database(join(input.testDirectory, "data", "inertia.sqlite"));
    try {
      if (reasoningId) {
        database.prepare("UPDATE agent_reasonings SET created_at = ? WHERE id = ?").run(at(3 * MINUTE - 52 * SECOND), reasoningId);
      }
    } finally {
      database.close();
    }
    pinConversationTimes(input.testDirectory, conversations, [
      ["running", 3 * MINUTE + 12 * SECOND],
      ["approval", 4 * MINUTE + 15 * SECOND],
      ["question", 6 * MINUTE + 20 * SECOND],
    ], ["running"]);
  }
}
