// @inertia-e2e-resource isolated
import { expect, test, type Locator, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import WebSocket from "ws";

import { RuntimeStore } from "../../src/server/database";
import type { UpsertSubagentTraceInput } from "../../src/server/persistence/types";
import type { ServerEvent, SubagentTaskUsage } from "../../src/shared/contracts";
import { CUSTOM_AGENT_PRESETS } from "../../src/shared/custom-agent-presets";
import {
  buildCustomAgentExport,
  customAgentExportSchema,
  customAgentIconSchema,
  type CustomAgent,
  type CustomAgentCallAttribution,
  type CustomAgentDelivery,
  type CustomAgentDraft,
} from "../../src/shared/custom-agents";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { setAppearanceInPlace } from "./support/appearance";

const WIDTH = 1512;
const HEIGHT = 868;
const MESSAGE_FIELD = 'textarea[aria-label="Message"]';
const CAPTURE_DIRECTORY = process.env.INERTIA_CAPTURE_DIR?.trim() || null;
const MODEL = "claude-sonnet-4-5";
const LIVE_TITLE = "Review the turn preparation change";
const DONE_TITLE = "Turn preparation review";
const LIVE_ACTIVITY = "Reading src/server/runtime/turns/turn-request-preparation.ts";
const RESULT_FIRST_LINE = "No blocking issues in the turn preparation change.";

let app!: AppFixture;
let page!: Page;

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function portraitPng(size = 64): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = size * 4 + 1;
  const pixels = Buffer.alloc(stride * size);
  const centre = (size - 1) / 2;
  const mix = (from: number, to: number, amount: number): number => Math.round(from + (to - from) * amount);
  for (let y = 0; y < size; y += 1) {
    pixels[y * stride] = 0;
    for (let x = 0; x < size; x += 1) {
      const diagonal = (x + y) / (2 * (size - 1));
      let rgb = [mix(124, 34, diagonal), mix(92, 195, diagonal), mix(255, 166, diagonal)];
      const distance = Math.hypot(x - centre, y - centre);
      const lens = Math.min(1, Math.max(0, 15 - distance));
      rgb = rgb.map((channel) => mix(channel, 246, lens));
      const pupil = Math.min(1, Math.max(0, 7 - Math.hypot(x - centre - 2, y - centre + 1)));
      rgb = rgb.map((channel) => mix(channel, 24, pupil));
      const glint = Math.min(1, Math.max(0, 2.2 - Math.hypot(x - centre + 1, y - centre - 3)));
      rgb = rgb.map((channel) => mix(channel, 255, glint));
      pixels.set([...rgb, 255], y * stride + 1 + x * 4);
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

function usage(update: Partial<SubagentTaskUsage>): SubagentTaskUsage {
  return {
    totalTokens: null,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    contextTokens: null,
    maxContextTokens: null,
    ...update,
  };
}

function presetDraft(presetId: string, update: Partial<CustomAgentDraft> = {}): CustomAgentDraft {
  const preset = CUSTOM_AGENT_PRESETS.find(({ id }) => id === presetId);
  if (!preset) throw new Error(`Unknown preset ${presetId}`);
  return {
    name: preset.name,
    handle: preset.id,
    description: preset.summary,
    icon: preset.icon,
    accent: preset.accent,
    blocks: preset.blocks.map(({ kind, body }) => ({ id: randomUUID(), kind, body })),
    skills: [...(preset.skills ?? [])],
    ...update,
  };
}

function withStore<T>(fixture: AppFixture, operation: (store: RuntimeStore) => T): T {
  const store = new RuntimeStore(join(fixture.testDirectory, "data", "inertia.sqlite"), fixture.workspaceDirectory, {
    recoverInterruptedRuns: false,
  });
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

async function createAgentsThroughRuntime(drafts: readonly CustomAgentDraft[]): Promise<void> {
  const { websocketUrl } = await app.runtimeSnapshot();
  if (!websocketUrl) throw new Error("Fixture runtime is unavailable.");
  const pending = [...drafts];
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(websocketUrl, { origin: "inertia://bundle", maxPayload: 2 * 1024 * 1024 });
    let requestId = "";
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const sendNext = (): void => {
      const agent = pending.shift();
      if (!agent) {
        finish();
        return;
      }
      requestId = randomUUID();
      socket.send(JSON.stringify({ type: "custom-agent.create", requestId, payload: { agent, onHandleConflict: "reject" } }));
    };
    const timer = setTimeout(() => finish(new Error("Creating custom agents through the runtime timed out.")), 20_000);
    socket.on("error", (error) => finish(error));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ServerEvent;
      const event = frame.type === "runtime.event" ? frame.event : frame;
      if (event.type === "server.welcome") sendNext();
      else if ((event.type === "request.ok" || event.type === "request.result") && event.requestId === requestId) sendNext();
      else if (event.type === "request.error" && event.requestId === requestId) finish(new Error(event.message));
    });
  });
}

function storedAgents(): CustomAgent[] {
  return withStore(app, (store) => store.customAgents().list());
}

function storedAgent(handle: string): CustomAgent {
  const agent = storedAgents().find((candidate) => candidate.handle === handle);
  if (!agent) throw new Error(`No stored agent /calling ${handle}`);
  return agent;
}

async function settleFrame(target: Page): Promise<void> {
  await target.evaluate(async () => {
    await document.fonts.ready;
    const finite = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === "running" && typeof end === "number" && Number.isFinite(end);
    });
    await Promise.race([
      Promise.all(finite.map((animation) => animation.finished.catch(() => undefined))),
      new Promise((resolve) => window.setTimeout(resolve, 3_000)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function capture(target: Page, name: string): Promise<void> {
  if (!CAPTURE_DIRECTORY) return;
  await mkdir(CAPTURE_DIRECTORY, { recursive: true });
  await settleFrame(target);
  const session = await target.context().newCDPSession(target);
  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await settleFrame(target);
    const { data } = await session.send("Page.captureScreenshot", { format: "png" });
    await writeFile(join(CAPTURE_DIRECTORY, name), Buffer.from(data, "base64"));
  } finally {
    await session.send("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}

async function holdSavedNotices(target: Page, hold: boolean): Promise<void> {
  if (!CAPTURE_DIRECTORY) return;
  await target.evaluate((enabled) => {
    const native = (Reflect.get(window, "__nativeSetTimeout") as typeof window.setTimeout | undefined) ?? window.setTimeout;
    Reflect.set(window, "__nativeSetTimeout", native);
    const held = (Reflect.get(window, "__heldTimers") as TimerHandler[] | undefined) ?? [];
    Reflect.set(window, "__heldTimers", held);
    if (enabled) {
      window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
        if (delay !== 2_000) return native(handler, delay, ...rest);
        held.push(handler);
        return 0;
      }) as typeof window.setTimeout;
      return;
    }
    window.setTimeout = native;
    for (const handler of held.splice(0)) native(handler, 0);
  }, hold);
}

async function openCustomAgents(target: Page): Promise<Locator> {
  await target.getByRole("button", { name: "Settings", exact: true }).click();
  await target.getByRole("button", { name: "Custom agents", exact: true }).click();
  const settings = target.locator(".custom-agents-settings");
  await expect(settings).toBeVisible();
  return settings;
}

async function backToWorkspace(target: Page): Promise<void> {
  await target.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(target.locator(MESSAGE_FIELD)).toBeVisible();
}

function agentRows(settings: Locator): Locator {
  return settings.getByRole("list", { name: "Custom agents" }).locator(":scope > li.custom-agent-row:not(.is-new)");
}

function agentRow(settings: Locator, handle: string): Locator {
  return agentRows(settings).filter({ has: settings.page().getByText(`/calling ${handle}`, { exact: true }) });
}

async function stubDialog(method: "showOpenDialog" | "showSaveDialog", path: string): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, { method: name, path: file }) => {
    Reflect.set(dialog, name, async () => name === "showOpenDialog"
      ? { canceled: false, filePaths: [file], bookmarks: [] }
      : { canceled: false, filePath: file, bookmark: undefined });
  }, { method, path });
}

async function imageLoaded(avatar: Locator): Promise<{ kind: string | null; width: number; complete: boolean }> {
  return avatar.evaluate((element) => {
    const image = element.querySelector("img");
    return {
      kind: element.getAttribute("data-icon-kind"),
      width: image?.naturalWidth ?? 0,
      complete: image?.complete ?? false,
    };
  });
}

function attribution(agent: CustomAgent, delivery: CustomAgentDelivery): CustomAgentCallAttribution {
  const { id, revision, handle, name, icon, accent } = agent;
  return { agentId: id, revision, handle, name, icon, accent, delivery };
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

function seedTranscripts(): { live: string; done: string } {
  const seeded = withStore(app, (store) => {
    const shell = store.shellSnapshot();
    const projectId = shell.activeProjectId;
    if (!projectId) throw new Error("The custom agents fixture has no project.");
    const reviewer = store.customAgents().getByHandle("code-reviewer");
    const docs = store.customAgents().getByHandle("docs-writer");
    if (!reviewer || !docs) throw new Error("The transcript fixture needs the reviewer and docs agents.");
    const selection = providerNativeModelSelection({ providerId: "claude", modelId: MODEL });
    const continuationIdentity = continuationIdentityForSelection(selection, "native:claude:e2e");
    const at = (secondsAgo: number): string => new Date(Date.now() - secondsAgo * 1_000).toISOString();
    const begin = (conversationId: string, content: string, call: CustomAgentCallAttribution, requestedAt: string) =>
      store.beginAgentTurn({
        conversationId,
        runId: `custom-agents-${randomUUID()}`,
        content,
        providerId: "claude",
        modelSelection: selection,
        continuationIdentity,
        reasoningEffort: "",
        interactionMode: "build",
        accessMode: "supervised",
        providerSessionBefore: "claude-e2e-session",
        configurationRevision: selection.backendConfigurationRevision,
        association: "authoritative",
        customAgentCall: call,
        requestedAt,
      }).turn;
    const trace = (turn: { id: string; runId: string; conversationId: string }, input: Omit<UpsertSubagentTraceInput, "conversationId" | "runId" | "turnId" | "providerId">) =>
      store.upsertSubagentTrace({ ...input, conversationId: turn.conversationId, runId: turn.runId, turnId: turn.id, providerId: "claude" })?.trace;
    const finish = (turn: { id: string; conversationId: string }, answer: string, completedAt: string, startedAt: string): void => {
      const message = store.createMessage(turn.conversationId, answer, "assistant", [], turn.id, completedAt);
      store.updateAgentTurnLifecycle(turn.id, {
        status: "completed",
        terminalReason: "provider-completed",
        terminalAssistantMessageId: message.id,
        startedAt,
        completedAt,
        updatedAt: completedAt,
      });
    };

    const done = store.createConversation(projectId, DONE_TITLE, { providerId: "claude" });
    const reviewTurn = begin(done.id, "Review the turn preparation change before I merge it.", attribution(reviewer, "subagent"), at(900));
    const doneTrace = trace(reviewTurn, {
      ...traceDefaults,
      providerTaskId: "task-review-done",
      providerAgentId: "agent-review-done",
      providerName: "inertia-code-reviewer",
      customAgentId: reviewer.id,
      status: "completed",
      isLive: false,
      description: LIVE_TITLE,
      result: [
        RESULT_FIRST_LINE,
        "",
        "- `prepareTurnRequest` freezes the agent identity before the provider starts.",
        "- The in-role path keeps the parent session, so no extra context is lost.",
      ].join("\n"),
      model: MODEL,
      usage: usage({ totalTokens: 48_200, inputTokens: 39_000, outputTokens: 2_300 }),
      toolUseCount: 12,
      durationMs: 94_000,
      sequence: 1,
      updatedAt: at(800),
    });
    finish(reviewTurn, "Code reviewer found nothing blocking. Two notes are in its report above.", at(780), at(898));
    const roleTurn = begin(done.id, "Rewrite the custom agents section of the README for first-time users.", attribution(docs, "in-role"), at(600));
    finish(roleTurn, "Here is the rewritten section. It leads with `/calling`, then shows how to start from a preset.", at(560), at(598));

    const live = store.createConversation(projectId, LIVE_TITLE, { providerId: "claude" });
    const liveTurn = begin(live.id, "Review the turn preparation change and tell me what would break.", attribution(reviewer, "subagent"), at(40));
    store.updateAgentTurnLifecycle(liveTurn.id, { status: "running", startedAt: at(38), updatedAt: at(38) });
    store.updateConversation(live.id, { status: "running" });
    const liveTrace = trace(liveTurn, {
      ...traceDefaults,
      providerTaskId: "task-review-live",
      providerAgentId: "agent-review-live",
      providerName: "inertia-code-reviewer",
      customAgentId: reviewer.id,
      status: "running",
      isLive: true,
      description: LIVE_TITLE,
      progress: "Tracing the calledAgent branch",
      activity: LIVE_ACTIVITY,
      model: MODEL,
      usage: usage({ totalTokens: 21_400 }),
      toolUseCount: 7,
      sequence: 1,
      updatedAt: at(5),
    });
    const childTrace = trace(liveTurn, {
      ...traceDefaults,
      providerTaskId: "task-caller-scout",
      providerAgentId: "agent-caller-scout",
      parentProviderAgentId: "agent-review-live",
      providerName: "Caller scout",
      status: "running",
      isLive: true,
      description: "Find every caller of prepareTurnRequest.",
      activity: "Searching src/server for prepareTurnRequest",
      model: MODEL,
      sequence: 2,
      updatedAt: at(3),
    });
    store.updateSettings({ theme: "dark", autoCollapseWorkLog: true });
    store.selectConversation(live.id);
    return { live: live.id, done: done.id, startedAt: [[doneTrace, at(894)], [liveTrace, at(34)], [childTrace, at(21)]] as const };
  });
  const database = new Database(join(app.testDirectory, "data", "inertia.sqlite"));
  try {
    const backdate = database.prepare("UPDATE subagent_traces SET created_at = ? WHERE id = ?");
    for (const [trace, createdAt] of seeded.startedAt) {
      if (!trace) throw new Error("A custom agent trace was not created.");
      backdate.run(createdAt, trace.id);
    }
  } finally {
    database.close();
  }
  return { live: seeded.live, done: seeded.done };
}

async function showConversation(conversationId: string, title: string): Promise<void> {
  withStore(app, (store) => store.selectConversation(conversationId));
  await page.reload();
  await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "custom-agents",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        store.updateSettings({ theme: "dark", interfaceScale: "default", responseDensity: "default" });
      } finally {
        store.close();
      }
    },
  });
  page = app.page;
});

test.afterAll(async () => {
  await app?.close();
});

test("builds, duplicates, deletes, exports and imports custom agents from Settings", async () => {
  test.setTimeout(240_000);
  await app.resizeWindow(WIDTH, HEIGHT);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const composer = page.locator(MESSAGE_FIELD);
  await composer.fill("/calling");
  const emptyMenu = page.getByRole("listbox", { name: "Custom agents" });
  await expect(emptyMenu.getByRole("status")).toHaveText("No custom agents yet");
  await emptyMenu.getByRole("option", { name: "Create one in Settings" }).click();
  const settings = page.locator(".custom-agents-settings");
  await expect(settings).toBeVisible();
  await expect(page.getByRole("button", { name: "Custom agents", exact: true })).toHaveAttribute("aria-current", "page");

  const empty = settings.locator(".custom-agents-empty");
  await expect(empty.getByText("No agents yet", { exact: true })).toBeVisible();
  const chips = empty.getByRole("group", { name: "Presets" }).getByRole("button");
  await expect(chips).toHaveText(CUSTOM_AGENT_PRESETS.map(({ name }) => name));
  await expect(chips.locator(".custom-agent-avatar")).toHaveCount(CUSTOM_AGENT_PRESETS.length);
  await expect(settings.getByRole("button", { name: "Export all agents" })).toBeDisabled();
  await page.mouse.move(0, 0);
  await capture(page, "01-settings-empty.png");

  await chips.filter({ hasText: /^Reviewer$/u }).click();
  const editor = settings.getByRole("form", { name: "New agent" });
  await expect(editor).toBeVisible();
  const name = editor.getByRole("textbox", { name: "Name", exact: true });
  const handle = editor.getByRole("textbox", { name: "Handle", exact: true });
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("Reviewer");
  await expect(handle).toHaveValue("reviewer");
  await expect(editor.getByRole("textbox", { name: "Description" })).toHaveValue(CUSTOM_AGENT_PRESETS[0]!.summary);
  await expect(editor.locator(".custom-agent-block-kind")).toHaveText(["Role", "Directions", "Must", "Must not"]);
  await expect(editor.getByRole("radio", { name: "Scout" })).toHaveAttribute("aria-checked", "true");
  await expect(editor.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");

  await name.fill("Code reviewer");
  await expect(handle).toHaveValue("code-reviewer");
  await expect(editor.getByText("Call it with /calling code-reviewer", { exact: true })).toBeVisible();
  await editor.getByRole("radio", { name: "Target" }).click();
  await expect(editor.getByRole("radio", { name: "Target" })).toHaveAttribute("aria-checked", "true");
  await expect(editor.getByRole("radio", { name: "Scout" })).toHaveAttribute("aria-checked", "false");
  await expect(editor.locator(".custom-agent-identity-preview")).toHaveAttribute("data-icon-kind", "symbol");
  await editor.getByRole("radio", { name: "Scout" }).click();
  await expect(editor.getByRole("radio", { name: "Scout" })).toHaveAttribute("aria-checked", "true");
  await expect(editor.getByRole("radio", { name: "Target" })).toHaveAttribute("aria-checked", "false");
  await editor.getByRole("radio", { name: "Teal" }).click();
  await expect(editor.getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
  await editor.getByRole("radio", { name: "Blue" }).click();
  await expect(editor.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
  await expect(editor.locator(".custom-agent-identity-preview")).toHaveAttribute("data-icon-kind", "mark");
  await expect(editor.locator(".custom-agent-identity-preview")).toHaveAttribute("data-mark", "scout");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  const reviewerRow = agentRow(settings, "code-reviewer");
  await expect(reviewerRow).toHaveCount(1);
  await expect(reviewerRow.locator("strong").first()).toHaveText("Code reviewer");
  await expect(reviewerRow.getByRole("status")).toHaveText("Saved");
  await expect.poll(() => storedAgents().map(({ name: agentName, handle: agentHandle, icon, accent, blocks }) => ({
    agentName, agentHandle, icon, accent, blocks: blocks.length,
  }))).toEqual([{
    agentName: "Code reviewer", agentHandle: "code-reviewer", icon: { kind: "mark", name: "scout" }, accent: "blue", blocks: 4,
  }]);

  await reviewerRow.getByRole("button", { name: "Duplicate Code reviewer" }).click();
  const copyRow = agentRow(settings, "code-reviewer-2");
  await expect(copyRow.locator("strong").first()).toHaveText("Code reviewer copy");
  await expect(agentRows(settings)).toHaveCount(2);
  await copyRow.getByRole("button", { name: "Delete Code reviewer copy" }).click();
  const confirm = settings.getByRole("group", { name: "Confirm deleting Code reviewer copy" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Delete agent" }).click();
  await expect(settings.getByText("Deleted Code reviewer copy", { exact: true })).toBeVisible();
  await expect(agentRows(settings)).toHaveCount(1);
  await expect.poll(() => storedAgents().map(({ handle: agentHandle }) => agentHandle)).toEqual(["code-reviewer"]);

  const exportPath = join(app.testDirectory, "exported-agents.json");
  await stubDialog("showSaveDialog", exportPath);
  await settings.getByRole("button", { name: "Export all agents" }).click();
  await expect(settings.getByText("Exported Code reviewer", { exact: true })).toBeVisible();
  const exported = customAgentExportSchema.parse(JSON.parse(await readFile(exportPath, "utf8")));
  expect(exported.agents).toHaveLength(1);
  expect(exported.agents[0]).toMatchObject({
    name: "Code reviewer",
    handle: "code-reviewer",
    icon: { kind: "mark", name: "scout" },
    accent: "blue",
  });

  const portrait = portraitPng();
  expect(customAgentIconSchema.safeParse({ kind: "image", data: portrait }).success).toBe(true);
  await createAgentsThroughRuntime([
    presetDraft("test-writer"),
    {
      name: "Visual QA",
      handle: "visual-qa",
      description: "Compares screenshots with the design and flags visible drift.",
      icon: { kind: "image", data: portrait },
      accent: "violet",
      blocks: [{ id: randomUUID(), kind: "role", body: "You compare UI screenshots with the design reference and report visible drift." }],
      skills: [],
    },
    presetDraft("security-auditor"),
    presetDraft("docs-writer"),
  ]);
  await page.reload();
  const seeded = await openCustomAgents(page);
  await expect(agentRows(seeded).locator(".custom-agent-row-title strong")).toHaveText([
    "Code reviewer", "Test writer", "Visual QA", "Security auditor", "Docs writer",
  ]);
  const visualAvatar = agentRow(seeded, "visual-qa").locator(".custom-agent-avatar");
  await expect.poll(() => imageLoaded(visualAvatar)).toEqual({ kind: "image", width: 64, complete: true });
  await expect(agentRow(seeded, "code-reviewer").locator(".custom-agent-avatar")).toHaveClass(/has-agent-tint/u);

  await agentRow(seeded, "docs-writer").getByRole("button", { name: "Edit Docs writer" }).click();
  const docsEditor = seeded.getByRole("form", { name: "Edit Docs writer" });
  await docsEditor.getByRole("textbox", { name: "Description" }).fill("Keeps the README and guides honest for first-time users.");
  await holdSavedNotices(page, true);
  await docsEditor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(docsEditor).toHaveCount(0);
  const docsRow = agentRow(seeded, "docs-writer");
  await expect(docsRow.getByRole("status")).toHaveText("Saved");
  await expect(docsRow.locator(".custom-agent-row-description")).toHaveText("Keeps the README and guides honest for first-time users.");
  await page.mouse.move(0, 0);
  await seeded.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await capture(page, "03-settings-list.png");
  await holdSavedNotices(page, false);
  await expect(docsRow.getByRole("status")).toHaveText("");
  expect(storedAgent("docs-writer").revision).toBe(2);

  await agentRow(seeded, "security-auditor").getByRole("button", { name: "Edit Security auditor" }).click();
  const auditEditor = seeded.getByRole("form", { name: "Edit Security auditor" });
  await expect(auditEditor.getByRole("heading", { name: "Identity", level: 4 })).toBeVisible();
  await expect(auditEditor.getByRole("heading", { name: "Instructions", level: 4 })).toBeAttached();
  await expect(auditEditor.getByRole("radio", { name: "Guard" })).toHaveAttribute("aria-checked", "true");
  await expect(auditEditor.getByRole("radio", { name: "Red" })).toHaveAttribute("aria-checked", "true");
  await expect(auditEditor.locator(".custom-agent-block-body").first()).toHaveValue(
    CUSTOM_AGENT_PRESETS.find(({ id }) => id === "security-auditor")!.blocks[0]!.body,
  );
  await agentRow(seeded, "visual-qa").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.mouse.move(0, 0);
  await capture(page, "02-settings-editor.png");
  await auditEditor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(auditEditor).toHaveCount(0);

  const importPath = join(app.testDirectory, "team-agents.json");
  await writeFile(importPath, `${JSON.stringify(buildCustomAgentExport([
    presetDraft("reviewer", {
      name: "Code reviewer (strict)",
      handle: "code-reviewer",
      description: "Blocks the merge on any unhandled error path.",
      icon: { kind: "symbol", name: "scale" },
      accent: "orange",
    }),
    presetDraft("upgrade-planner", {
      name: "Release notes writer",
      handle: "release-notes",
      description: "Drafts release notes from merged pull requests.",
      icon: { kind: "symbol", name: "book" },
      accent: "amber",
    }),
  ]), null, 2)}\n`);
  await stubDialog("showOpenDialog", importPath);
  await seeded.getByRole("button", { name: /^Import agents\s?…$/u }).click();
  const notice = "Imported 2 agents; renamed /calling code-reviewer → code-reviewer-2";
  await expect(seeded.getByText(notice, { exact: true })).toBeVisible();
  await expect(agentRows(seeded)).toHaveCount(7);
  await expect(agentRow(seeded, "code-reviewer-2").locator("strong").first()).toHaveText("Code reviewer (strict)");
  await expect(agentRow(seeded, "release-notes")).toHaveCount(1);
  expect(storedAgents().map(({ handle: agentHandle }) => agentHandle)).toEqual([
    "code-reviewer", "test-writer", "visual-qa", "security-auditor", "docs-writer", "code-reviewer-2", "release-notes",
  ]);
  await seeded.getByText(notice, { exact: true }).evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.mouse.move(0, 0);
  await capture(page, "08-settings-import-notice.png");

  await setAppearanceInPlace(app, "light");
  await agentRows(seeded).first().evaluate((element) => element.scrollIntoView({ block: "center" }));
  await capture(page, "09-settings-light.png");
  await setAppearanceInPlace(app, "dark");
  expect(app.rendererErrors).toEqual([]);
});

test("calls a custom agent from the composer with /calling", async () => {
  test.setTimeout(120_000);
  await app.resizeWindow(WIDTH, HEIGHT);
  await backToWorkspace(page);
  const composer = page.locator(MESSAGE_FIELD);
  await composer.fill("");
  await composer.fill("/calling");
  const menu = page.getByRole("listbox", { name: "Custom agents" });
  const options = menu.getByRole("option");
  await expect(options).toHaveCount(7);
  await expect(options.locator(".custom-agent-avatar")).toHaveCount(7);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-activedescendant", (await options.first().getAttribute("id"))!);
  await expect.poll(() => imageLoaded(options.filter({ hasText: "Visual QA" }).locator(".custom-agent-avatar")))
    .toEqual({ kind: "image", width: 64, complete: true });
  await expect(options.filter({ hasText: "Code reviewer (strict)" }).locator(".composer-agent-call-handle"))
    .toHaveText("/calling code-reviewer-2");

  await composer.fill("/calling rev");
  await expect(options.locator("strong")).toHaveText(["Code reviewer", "Code reviewer (strict)"]);
  await expect(options.first().locator("mark").first()).toHaveText(/rev/iu);
  await page.mouse.move(0, 0);
  await capture(page, "04-composer-calling-menu.png");

  await composer.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(composer).toHaveValue("/calling rev");
  await composer.fill("/calling code-r");
  await expect(options.locator("strong")).toHaveText(["Code reviewer", "Code reviewer (strict)"]);
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await composer.press("Tab");
  await expect(menu).toHaveCount(0);
  const chip = page.locator(".composer-called-agent");
  await expect(chip).toHaveAttribute("aria-label", "Calling Code reviewer");
  await expect(chip.locator("strong")).toHaveText("Code reviewer");
  await expect(chip.locator("small")).toHaveText("Calling as a subagent");
  await expect(chip.locator(".custom-agent-avatar")).toHaveClass(/has-agent-tint/u);
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute("placeholder", "What should Code reviewer do?");
  await page.mouse.move(0, 0);
  await capture(page, "05-composer-chip.png");

  await page.reload();
  await expect(page.locator(".composer-called-agent")).toHaveAttribute("aria-label", "Calling Code reviewer");
  await page.getByRole("button", { name: "Stop calling Code reviewer" }).click();
  await expect(page.locator(".composer-called-agent")).toHaveCount(0);
  await expect(composer).not.toHaveAttribute("placeholder", "What should Code reviewer do?");
  await expect(composer).toBeFocused();
  expect(app.rendererErrors).toEqual([]);
});

test("shows a called agent's live and finished subagent work in the transcript", async () => {
  test.setTimeout(150_000);
  await app.resizeWindow(WIDTH, HEIGHT);
  const seeded = seedTranscripts();

  await showConversation(seeded.live, LIVE_TITLE);
  const userBadge = page.locator(".message-agent-call");
  await expect(userBadge).toHaveCount(1);
  await expect(userBadge).toHaveAttribute("data-delivery", "subagent");
  await expect(userBadge.locator(".message-agent-call-name")).toHaveText("Called Code reviewer");
  await expect(userBadge.locator(".message-agent-call-delivery")).toHaveCount(0);

  const live = page.getByRole("region", { name: "Called agent Code reviewer" });
  await expect(live).toHaveAttribute("data-live", "true");
  await expect(live).toHaveAttribute("data-status", "running");
  await expect(live).toHaveAttribute("data-expanded", "true");
  const header = live.locator(".subagent-call-header");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(header.locator(".subagent-call-title strong")).toHaveText("Code reviewer");
  await expect(header.locator(".subagent-call-status")).toHaveText("Running");
  await expect(header.locator(".subagent-elapsed")).toHaveText(/^\d+s$/u);
  const avatar = header.locator(".custom-agent-avatar");
  await expect(avatar).toHaveAttribute("data-live", "true");
  await expect(avatar).toHaveAttribute("data-icon-kind", "mark");
  await expect(avatar).toHaveAttribute("data-mark", "scout");
  await expect(live.locator(".subagent-call-task")).toHaveText(LIVE_TITLE);
  await expect(live.locator('.subagent-call-activity[data-tone="live"]')).toHaveText(LIVE_ACTIVITY);
  const children = live.getByRole("list", { name: "Agents started by Code reviewer" });
  await expect(children.getByRole("listitem")).toHaveCount(1);
  await expect(children.locator(".subagent-call-child-name")).toHaveText("Caller scout");
  await expect(children.getByRole("listitem")).toContainText("Running");
  await expect(live.locator(".subagent-call-meta")).toContainText(MODEL);
  await expect(page.locator(".turn-execution-rail.is-live")).toBeVisible();
  await page.mouse.move(0, 0);
  await capture(page, "06-transcript-live.png");

  await header.click();
  await expect(live).toHaveAttribute("data-expanded", "false");
  await expect(live.locator(".subagent-call-line")).toHaveText(LIVE_ACTIVITY);
  await expect(live.locator(".subagent-call-body")).toHaveAttribute("aria-hidden", "true");
  await header.click();
  await expect(live).toHaveAttribute("data-expanded", "true");
  await expect(live.locator(".subagent-call-line")).toHaveCount(0);

  await showConversation(seeded.done, DONE_TITLE);
  const badges = page.locator(".message-agent-call");
  await expect(badges).toHaveCount(2);
  await expect(badges.nth(0)).toHaveAttribute("data-delivery", "subagent");
  await expect(badges.nth(0).locator(".message-agent-call-name")).toHaveText("Called Code reviewer");
  await expect(badges.nth(1)).toHaveAttribute("data-delivery", "in-role");
  await expect(badges.nth(1).locator(".message-agent-call-name")).toHaveText("Called Docs writer");
  await expect(badges.nth(1).locator(".message-agent-call-delivery")).toHaveText("in role");
  await expect(page.getByRole("region", { name: /^Called agent / })).toHaveCount(1);

  const done = page.getByRole("region", { name: "Called agent Code reviewer" });
  await expect(done).toHaveAttribute("data-live", "false");
  await expect(done).toHaveAttribute("data-status", "completed");
  await expect(done).toHaveAttribute("data-expanded", "false");
  await expect(done.locator(".subagent-call-status")).toHaveText("Completed");
  await expect(done.locator(".subagent-call-header .subagent-elapsed")).toHaveText("1m 34s");
  await expect(done.locator(".custom-agent-avatar")).not.toHaveAttribute("data-live", "true");
  await expect(done.locator(".subagent-call-line")).toHaveText(RESULT_FIRST_LINE);
  await expect(done.locator(".subagent-call-line")).toHaveAttribute("data-tone", "done");
  await expect(done.locator(".subagent-call-body")).toHaveAttribute("aria-hidden", "true");
  await badges.nth(1).evaluate((element) => element.scrollIntoView({ block: "end" }));
  await done.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.mouse.move(0, 0);
  await capture(page, "07-transcript-done.png");

  await done.locator(".subagent-call-header").click();
  await expect(done).toHaveAttribute("data-expanded", "true");
  await expect(done.locator(".subagent-call-line")).toHaveCount(0);
  await expect(done.locator(".subagent-call-task")).toHaveText(LIVE_TITLE);
  await expect(done.locator(".subagent-call-result")).toContainText("freezes the agent identity before the provider starts");
  await expect(done.locator(".subagent-call-meta small")).toHaveText("claude-sonnet-4-5 · 48.2K tokens · 12 tool uses · 1m 34s");
  await expect(done.getByRole("button", { name: "Stop Code reviewer" })).toHaveCount(0);
  expect(app.rendererErrors).toEqual([]);
});
