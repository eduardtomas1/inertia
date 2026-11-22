// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { rollbackConversationHistory } from "../../src/server/runtime/history-rollback-service";
import { retainedMissedRunImageCheck } from "../../src/server/runtime/attachments/trusted-attachment-resolver";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import { MISSED_RUN_WALK_LIMIT } from "../../src/server/orchestration-v2/missed-run-attachments";
import { resolveNativeModelRoute } from "./model-route-fixture";
import type { ChatAttachment, ProviderInfo } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, flushTurnControllerTestPromises,
  turnControllerTestIdentity, turnControllerTestProviderInfo, type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(() => { vi.restoreAllMocks(); return cleanupTurnControllerTestDirectories(); });

const claudeSelection = providerNativeModelSelection({ providerId: "claude", modelId: "claude-test" });
const codexSelection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-test", reasoningEffort: "high" });
const PNG = Buffer.from("89504e470d0a1a0a", "hex");

interface Fixture { runtime: TurnControllerTestRuntime; retained: string }

/** A runtime wired like production: the missed-run image hook checks this runtime's retained attachment folder. */
async function fixture(providerInfo?: () => ProviderInfo[], options: Parameters<typeof createTurnControllerTestRuntime>[1] = {}): Promise<Fixture> {
  const state = { retained: "" };
  const runtime = await createTurnControllerTestRuntime({
    missedRunImageCheck: () => retainedMissedRunImageCheck({ directory: state.retained })(),
    ...(providerInfo ? { providerInfo } : {}),
  }, options);
  await mkdir(join(runtime.directory, "retained"));
  // The store's folder is canonical, as `ConversationAttachmentStore.directory` is.
  state.retained = await realpath(join(runtime.directory, "retained"));
  return { runtime, retained: state.retained };
}

/** A retained image at the store layout `<retained>/<id>/<id>.png`, as a sent message's attachment. */
async function image(f: Fixture, name: string): Promise<ChatAttachment> {
  const id = randomUUID();
  const path = join(f.retained, id, `${id}.png`);
  await mkdir(join(f.retained, id));
  await writeFile(path, PNG);
  return { id, name, path, mimeType: "image/png", size: PNG.byteLength };
}

/** Queues and starts a turn, returning once its provider run has started. */
async function send(runtime: TurnControllerTestRuntime, content: string, attachments: ChatAttachment[] = [],
  extra: { goalStart?: { objective: string } } = {}) {
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content, attachments, ...extra });
  runtime.controller.start(queued.turn.id);
  await flushTurnControllerTestPromises();
  expect(runtime.provider.input?.turnId).toBe(queued.turn.id);
  return queued;
}

/** A run the provider accepted (it answered). */
async function delivered(runtime: TurnControllerTestRuntime, content: string, attachments: ChatAttachment[] = [],
  sessionId = "codex-native") {
  const queued = await send(runtime, content, attachments);
  const sent = [...(runtime.provider.input?.imagePaths ?? [])];
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId });
  runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: `${content} answer` });
  runtime.provider.resolve({ sessionId });
  await flushTurnControllerTestPromises();
  return { queued, sent };
}

/** A Codex run whose turn/start was refused: nothing reached the provider, so V2 records it not delivered. */
async function missed(runtime: TurnControllerTestRuntime, content: string, attachments: ChatAttachment[] = [],
  failure: { notDelivered?: true } = {}) {
  const queued = await send(runtime, content, attachments);
  const sent = [...(runtime.provider.input?.imagePaths ?? [])];
  runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: "Codex rejected the turn.",
    failure: { reason: "codex-error", message: "Codex rejected the turn.", ...failure } });
  await flushTurnControllerTestPromises();
  expect(runtime.store.orchestration.events.projection("run", queued.turn.runId)?.value)
    .toMatchObject({ delivery: "not-delivered" });
  return { queued, sent };
}

function messageAttachmentIds(runtime: TurnControllerTestRuntime, messageId: string): string[] {
  const row = (runtime.store as unknown as { database: Database.Database }).database
    .prepare("SELECT attachments_json FROM messages WHERE id = ?").get(messageId) as { attachments_json: string };
  return (JSON.parse(row.attachments_json) as { id: string }[]).map(({ id }) => id);
}

function manifestImageCount(store: RuntimeStore, turnId: string): number {
  const row = (store as unknown as { database: Database.Database }).database
    .prepare("SELECT manifest_json FROM turn_execution_manifests WHERE turn_id = ?").get(turnId) as { manifest_json: string };
  return (JSON.parse(row.manifest_json) as { imageCount: number }).imageCount;
}

describe("images of runs the provider never received ride on the next prompt (T3 missed runs)", () => {
  it("prepends a missed Codex run's image to the next prompt only, and stops once a later run is delivered", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      expect((await missed(runtime, "Look at this", [screenshot])).sent).toEqual([screenshot.path]);

      const own = await image(f, "own.png");
      const retry = await delivered(runtime, "Try again", [own]);
      expect(retry.sent).toEqual([screenshot.path, own.path]);
      // The transcript keeps only the user's own attachment; release and the persisted message never see the carried one.
      expect(retry.queued.message.attachments.map(({ id }) => id)).toEqual([own.id]);
      expect(messageAttachmentIds(runtime, retry.queued.message.id)).toEqual([own.id]);
      expect(runtime.attachmentReleases.at(-1)).toEqual([own.id]);
      expect(manifestImageCount(runtime.store, retry.queued.turn.id)).toBe(2);

      expect((await delivered(runtime, "Next request")).sent).toEqual([]);
    } finally { runtime.store.close(); }
  });

  it("carries two consecutive missed runs oldest first, deduplicated by id, and survives a thread-in-use refusal", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const first = await image(f, "first.png");
      const shared = await image(f, "shared.png");
      await missed(runtime, "First try", [first, shared]);
      const second = await image(f, "second.png");
      // The Codex "thread in use" refusal: an explicit not-delivered failure. Its own start carried the first images.
      const refused = await missed(runtime, "Second try", [second], { notDelivered: true });
      expect(refused.sent).toEqual([first.path, shared.path, second.path]);

      const retry = await delivered(runtime, "Third try", [shared]);
      expect(retry.sent).toEqual([first.path, second.path, shared.path]);
      expect(retry.queued.message.attachments.map(({ id }) => id)).toEqual([shared.id]);
    } finally { runtime.store.close(); }
  });

  it("walks past another provider instance and a goal start, and never carries a rolled-back missed run", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      const opening = await delivered(runtime, "Opening request");
      const codexImage = await image(f, "codex.png");
      await missed(runtime, "Codex try", [codexImage]);

      // A delivered run on another provider instance neither stops the walk nor contributes.
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const claudeImage = await image(f, "claude.png");
      await delivered(runtime, "Claude turn", [claudeImage], "claude-native");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      expect((await missed(runtime, "Back on Codex")).sent).toEqual([codexImage.path]);

      // A goal start withholds its prompt: it carries nothing and its acceptance does not stop the walk.
      const goal = await send(runtime, "/goal Ship the exporter", [], { goalStart: { objective: "Ship the exporter" } });
      expect(runtime.provider.input?.imagePaths ?? []).toEqual([]);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ text: "Goal accepted.", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.agentTurn(goal.turn.id).status).toBe("completed");

      const next = await send(runtime, "After the goal");
      expect(runtime.provider.input?.imagePaths).toEqual([codexImage.path]);
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: "Codex rejected the turn.",
        failure: { reason: "codex-error", message: "Codex rejected the turn." } });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.events.projection("run", next.turn.runId)?.value)
        .toMatchObject({ delivery: "not-delivered" });

      // Roll back to the opening turn: every later run, missed or not, is rolled back and carries nothing.
      const deps = { store: runtime.store, turns: runtime.controller,
        providerTerminalResumes: new ProviderTerminalResumeRegistry(runtime.store.conversationWork),
        providers: { resolveModelRoute: runtime.provider.resolveModelRoute,
          isRunning: (id: string) => runtime.provider.isRunning(id),
          nativeConversation: vi.fn(async (request: { operationId: string; source: { identity: unknown } }) => ({
            operationId: request.operationId, identity: request.source.identity, status: "unsupported" as const,
            reason: "native-history-control-unavailable" as const })) } };
      const source = { actorId: "human", commandId: "rollback-missed", command: { type: "conversation.rollback",
        requestId: "rollback-missed", payload: { conversationId: runtime.conversationId, turnId: opening.queued.turn.id } } };
      await expect(rollbackConversationHistory(deps as never, { conversationId: runtime.conversationId,
        turnId: opening.queued.turn.id, source }, new AbortController().signal)).resolves.toMatchObject({ transfer: "portable" });

      const afterRollback = await image(f, "after-rollback.png");
      expect((await missed(runtime, "After rollback", [afterRollback])).sent).toEqual([afterRollback.path]);
      expect((await delivered(runtime, "Retry after rollback")).sent).toEqual([afterRollback.path]);
    } finally { runtime.store.close(); }
  });

  it("carries none to a model without image input, and drops the oldest missed images first over the limit", async () => {
    const textOnly = (): ProviderInfo[] => {
      const info = turnControllerTestProviderInfo();
      return [{ ...info, models: info.models.map((model) => model.id === "gpt-next"
        ? { ...model, inputModalities: ["text"] } : model) }];
    };
    const f = await fixture(textOnly);
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const oldest = await image(f, "oldest.png");
      await missed(runtime, "Oldest try", [oldest]);
      const newer = await image(f, "newer.png");
      await missed(runtime, "Newer try", [newer]);

      // Same provider instance, a model without image input: nothing rides and the send is not refused.
      runtime.store.updateConversation(runtime.conversationId, { model: "gpt-next" });
      expect((await missed(runtime, "Text-only try")).sent).toEqual([]);
      runtime.store.updateConversation(runtime.conversationId, { model: "gpt-test" });

      // Codex takes at most 32 images per message: 31 of the message's own leave room for the newest missed one.
      const own = await Promise.all(Array.from({ length: 31 }, (_, index) => image(f, `own-${index}.png`)));
      const retry = await delivered(runtime, "Full message", own);
      expect(retry.sent).toEqual([newer.path, ...own.map(({ path }) => path)]);
    } finally { runtime.store.close(); }
  });

  it("skips a missed image whose retained file is gone", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const gone = await image(f, "gone.png");
      const kept = await image(f, "kept.png");
      await missed(runtime, "Missed try", [gone, kept]);
      await rm(join(f.retained, gone.id), { recursive: true });
      expect((await delivered(runtime, "Retry")).sent).toEqual([kept.path]);
    } finally { runtime.store.close(); }
  });

  it.skipIf(process.platform === "win32")("skips a missed image whose retained file or folder is a symlink", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const linkedFile = await image(f, "linked-file.png");
      const linkedFolder = await image(f, "linked-folder.png");
      const kept = await image(f, "kept.png");
      await missed(runtime, "Missed try", [linkedFile, linkedFolder, kept]);
      const outside = join(runtime.directory, "outside");
      await mkdir(outside);
      await writeFile(join(outside, `${linkedFile.id}.png`), PNG);
      await writeFile(join(outside, `${linkedFolder.id}.png`), PNG);
      await rm(linkedFile.path);
      await symlink(join(outside, `${linkedFile.id}.png`), linkedFile.path);
      await rm(join(f.retained, linkedFolder.id), { recursive: true });
      await symlink(outside, join(f.retained, linkedFolder.id), "dir");
      expect((await delivered(runtime, "Retry")).sent).toEqual([kept.path]);
    } finally { runtime.store.close(); }
  });

  it("keeps the missed images on the fresh-session replacement after a rejected resume (G9)", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      await missed(runtime, "Look at this", [screenshot]);
      const own = await image(f, "own.png");
      const retry = await send(runtime, "Try again", [own]);
      expect(runtime.provider.input?.sessionId).toBe("codex-native");
      expect(runtime.provider.input?.imagePaths).toEqual([screenshot.path, own.path]);
      const replacement = runtime.provider.freshSession();
      expect(replacement).not.toBeNull();
      // The replacement attempt's request was reassembled; it still counts the carried image beside the user's own.
      expect(manifestImageCount(runtime.store, retry.turn.id)).toBe(2);
      expect(runtime.provider.input?.imagePaths).toEqual([screenshot.path, own.path]);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-fresh" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Seen" });
      runtime.provider.resolve({ sessionId: "codex-fresh" });
      await flushTurnControllerTestPromises();
      expect(retry.message.attachments.map(({ id }) => id)).toEqual([own.id]);
    } finally { runtime.store.close(); }
  });

  it("never carries or pins a run the user stopped before Codex accepted it, and walks past it", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      await missed(runtime, "Look at this", [screenshot]);
      const withdrawn = await image(f, "withdrawn.png");
      const stopped = await send(runtime, "Never mind this one", [withdrawn]);
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      // T3 resends a cancelled run only after its provider dropped the prompt; a Stop before acceptance withdraws it.
      expect(runtime.store.orchestration.events.projection("run", stopped.turn.runId)?.value)
        .toMatchObject({ status: "cancelled", delivery: "not-delivered" });
      expect(runtime.store.evictableAttachmentIds()).toContain(withdrawn.id);
      expect(runtime.store.evictableAttachmentIds()).not.toContain(screenshot.id);

      expect((await delivered(runtime, "Next request")).sent).toEqual([screenshot.path]);
    } finally { runtime.store.close(); }
  });

  it("carries and pins the images of a run stopped after its provider dropped the prompt, though output streamed (T3 c5fa33b27)", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      const stopped = await send(runtime, "Look at this", [screenshot]);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "text", text: "Looking" });
      // The Stop settles the turn once the provider run settled; the harness reports its terminal status first.
      runtime.provider.deferOwnedStop("settled");
      runtime.controller.cancel(runtime.conversationId);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "cancelled", promptDropped: true });
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      runtime.provider.resolveOwnedStop();
      await flushTurnControllerTestPromises();
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.events.projection("run", stopped.turn.runId)?.value)
        .toMatchObject({ status: "cancelled", delivery: "not-delivered", promptDropped: true });
      expect(runtime.store.evictableAttachmentIds()).not.toContain(screenshot.id);

      // A later stopped run without a dropped prompt neither carries its own image nor ends the carry.
      const withdrawn = await image(f, "withdrawn.png");
      const later = await send(runtime, "Never mind", [withdrawn]);
      expect(runtime.provider.input?.imagePaths).toEqual([screenshot.path, withdrawn.path]);
      runtime.provider.resolve({ status: "cancelled", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.events.projection("run", later.turn.runId)?.value)
        .toMatchObject({ status: "cancelled", delivery: "not-delivered" });
      expect(runtime.store.orchestration.events.projection("run", later.turn.runId)?.value).not.toHaveProperty("promptDropped");
      expect(runtime.store.evictableAttachmentIds()).toContain(withdrawn.id);

      expect((await delivered(runtime, "Try again")).sent).toEqual([screenshot.path]);
      expect(runtime.store.evictableAttachmentIds()).toContain(screenshot.id);
    } finally { runtime.store.close(); }
  });

  it("never evicts a pending missed image, and evicts it once a later delivered run superseded it", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      await missed(runtime, "Look at this", [screenshot]);
      expect(runtime.store.evictableAttachmentIds()).not.toContain(screenshot.id);

      // Another instance's delivered run and a goal start do not supersede it.
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      await delivered(runtime, "Claude turn", [], "claude-native");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      await missed(runtime, "Back on Codex");
      await send(runtime, "/goal Ship it", [], { goalStart: { objective: "Ship it" } });
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "session", sessionId: "codex-native" });
      runtime.provider.resolve({ text: "Goal accepted.", sessionId: "codex-native" });
      await flushTurnControllerTestPromises();
      expect(runtime.store.evictableAttachmentIds()).not.toContain(screenshot.id);

      await delivered(runtime, "Retry");
      expect(runtime.store.evictableAttachmentIds()).toContain(screenshot.id);
    } finally { runtime.store.close(); }
  });
  it("treats a refused turn whose history was injected as missed, while its route still counts as reached", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Original Codex request");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      const other = await delivered(runtime, "Claude follow-up", [], "claude-native");
      runtime.store.updateConversation(runtime.conversationId, { providerId: "codex", modelSelection: codexSelection });
      const screenshot = await image(f, "screenshot.png");
      const returned = await send(runtime, "Return to Codex", [screenshot]);
      const injection = runtime.provider.callbacks!.historyInjection!;
      expect(injection.begin()).toBe(true);
      expect(injection.delivered()).toBe(true);
      runtime.provider.resolve({ status: "failed", sessionId: "codex-native", error: "Codex rejected the turn.",
        failure: { reason: "codex-error", message: "Codex rejected the turn." } });
      await flushTurnControllerTestPromises();
      expect(runtime.store.orchestration.events.projection("run", returned.turn.runId)?.value)
        .toMatchObject({ delivery: "prompt-not-delivered" });
      // The injected history reached the route: the switch is no longer due.
      expect(runtime.store.orchestration.backings.deliveredRouteTurnId(runtime.conversationId)).toBe(returned.turn.id);
      expect(other.queued.turn.id).not.toBe(returned.turn.id);
      expect(runtime.store.evictableAttachmentIds()).not.toContain(screenshot.id);

      const retry = await delivered(runtime, "Try again");
      expect(retry.sent).toEqual([screenshot.path]);
      expect(runtime.store.evictableAttachmentIds()).toContain(screenshot.id);
    } finally { runtime.store.close(); }
  });

  it("orders turns with the same request time by insertion, not by id", async () => {
    // One instant for every turn, and ids that sort below every earlier one.
    let sequence = 1_000_000;
    const f = await fixture(undefined, { clock: () => new Date("2030-01-01T00:00:00.000Z"),
      id: () => `controller-id-${--sequence}` });
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      await missed(runtime, "Look at this", [screenshot]);
      expect(runtime.store.evictableAttachmentIds()).not.toContain(screenshot.id);
      expect((await delivered(runtime, "Try again")).sent).toEqual([screenshot.path]);
      expect((await delivered(runtime, "Next request")).sent).toEqual([]);
      expect(runtime.store.evictableAttachmentIds()).toContain(screenshot.id);
    } finally { runtime.store.close(); }
  });

  it("reads only the chat's newest turns, and stops pinning a missed image older than that window", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      const lost = await missed(runtime, "Look at this", [screenshot]);
      const instance = (runtime.store.orchestration.events.projection("run", lost.queued.turn.runId)!.value as
        { providerInstanceId: string }).providerInstanceId;
      const due = () => runtime.store.orchestration.missedRunImages({ threadId: runtime.conversationId,
        providerInstanceId: instance }).map(({ id }) => id);
      // Turns on another instance pass the walk by, until the missed turn falls out of the window.
      runtime.store.updateConversation(runtime.conversationId, { providerId: "claude", modelSelection: claudeSelection });
      for (let index = 0; index < MISSED_RUN_WALK_LIMIT - 1; index += 1) {
        await delivered(runtime, `Claude turn ${index}`, [], "claude-native");
      }
      expect(due()).toEqual([screenshot.id]);
      expect(runtime.store.evictableAttachmentIds()).not.toContain(screenshot.id);
      await delivered(runtime, "One more Claude turn", [], "claude-native");
      expect(due()).toEqual([]);
      expect(runtime.store.evictableAttachmentIds()).toContain(screenshot.id);
    } finally { runtime.store.close(); }
  });

  it("drops a missed image that is the same file as one of the message's own", async () => {
    const f = await fixture();
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      await missed(runtime, "Look at this", [screenshot]);
      const again = { ...screenshot, id: randomUUID(), name: "again.png" };
      expect((await delivered(runtime, "Same file again", [again])).sent).toEqual([screenshot.path]);
    } finally { runtime.store.close(); }
  });

  it("carries none on a route whose harness takes no image input", async () => {
    const route: { harnessId?: "antigravity-cli" } = {};
    const f = await fixture(undefined, { resolveModelRoute: (selection) => {
      const resolved = resolveNativeModelRoute(selection);
      // Same provider instance (its continuation identity), served by a harness that refuses images.
      return route.harnessId ? { ...resolved, harnessId: route.harnessId } : resolved;
    } });
    const { runtime } = f;
    try {
      await delivered(runtime, "Opening request");
      const screenshot = await image(f, "screenshot.png");
      await missed(runtime, "Look at this", [screenshot]);
      route.harnessId = "antigravity-cli";
      expect((await missed(runtime, "No images here")).sent).toEqual([]);
      delete route.harnessId;
      expect((await delivered(runtime, "Back on Codex")).sent).toEqual([screenshot.path]);
    } finally { runtime.store.close(); }
  });
});
