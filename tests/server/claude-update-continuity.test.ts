import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { resolveNativeModelRoute } from "./model-route-fixture";

const stores: RuntimeStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-claude-continuity-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const openStore = () => {
    const result = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, { recoverInterruptedRuns: false });
    stores.push(result);
    return result;
  };
  const store = openStore();
  const project = store.createProject("Continuity", workspace);
  const selection = providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" });
  const conversation = store.createConversation(project.id, "Existing work", { modelSelection: selection });
  const route = resolveNativeModelRoute(selection);
  store.createMessage(conversation.id, "The export must preserve accented names.", "user", [], null, "2030-01-01T00:00:00.000Z");
  const answer = store.createMessage(conversation.id, "I will use UTF-8", "assistant", [], null, "2030-01-01T00:00:01.000Z");
  store.appendMessageContent(answer.id, " and verify café.");
  const other = store.createConversation(project.id, "Unrelated", { modelSelection: selection });
  store.createMessage(other.id, "OTHER_CHAT_PRIVATE_SENTINEL");
  const previous = { ...route.continuationIdentity, providerCompatibilityToken: "b".repeat(64) };
  let sequence = 0;
  const resolve = (activeStore = store) => resolveTurnRequest({
    store: activeStore,
    providers: {
      resolveModelRoute: () => route,
      harnessIdFor: () => route.harnessId,
    } as unknown as TurnProviderRuntime,
    hooks: { broadcast: () => undefined, broadcastSnapshot: () => undefined, providerInfo: () => [] },
    id: () => `continuity-${++sequence}`,
    now: () => "2030-01-01T00:01:00.000Z",
    clock: () => new Date("2030-01-01T00:01:00.000Z"),
  }, { conversationId: conversation.id, content: "Continue the export." });
  return { store, conversation, route, previous, resolve, openStore };
}

describe("Claude update continuity", () => {
  it("recovers text after NULs in stored and streamed messages through the provider prompt", async () => {
    const f = await fixture();
    const answer = f.store.createMessage(f.conversation.id, "Before\0 preserve the first requirement. ", "assistant");
    f.store.appendMessageContent(answer.id, "Next\0 preserve the second requirement.");
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    const history = f.store.continuationHistory(f.conversation.id);
    expect(history.truncated).toBe(false);
    const resolved = f.resolve();
    const input = resolved.adopt(f.store.beginAgentTurn(resolved.input)).active.providerInput;
    expect(input.prompt).toContain("preserve the first requirement");
    expect(input.prompt).toContain("preserve the second requirement");
    expect(input.prompt).not.toContain("\\u0000");
  });

  it.each([false, true])("drops partial credentials at the byte boundary before redaction (streamed: %s)", async (streamed) => {
    const f = await fixture();
    const prefix = "OPENAI_API_KEY=synthetic-credential ".repeat(100);
    const body = prefix + " ".repeat(8189 - prefix.length) + "sk-" + "Q".repeat(50);
    const message = f.store.createMessage(f.conversation.id, streamed ? "" : body, "assistant");
    if (streamed) f.store.appendMessageContent(message.id, body);
    const history = f.store.continuationHistory(f.conversation.id);
    expect(history.truncated).toBe(true);
    expect(history.content).not.toContain("sk-");
    expect(history.content).not.toContain("synthetic-credential");
    expect(history.content).toContain("[redacted]");
  });

  it("joins small chunks before redacting and retains text beyond the old 32-chunk cap", async () => {
    const f = await fixture();
    const answer = f.store.createMessage(f.conversation.id, "", "assistant");
    for (const text of "Start OPENAI_API_KEY=synthetic-credential End 😀") f.store.appendMessageContent(answer.id, text);
    const history = f.store.continuationHistory(f.conversation.id);
    expect(history.truncated).toBe(false);
    expect(history.content).toContain("Start [redacted] End 😀");
    expect(history.content).not.toContain("synthetic-credential");
  });

  it("recovers bounded visible context without reusing an invalidated native session", async () => {
    const f = await fixture();
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    const resolved = f.resolve();
    const queued = f.store.beginAgentTurn(resolved.input);
    const input = resolved.adopt(queued).active.providerInput;
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain("The export must preserve accented names.");
    expect(input.prompt).toContain("I will use UTF-8 and verify café.");
    expect(input.prompt).not.toContain("OTHER_CHAT_PRIVATE_SENTINEL");
    expect(input.prompt).toContain("Historical reference only");
    expect(queued.turn.continuationReasonCode).toBe("provider-installation-changed");
    expect(f.store.turnExecutionManifest(queued.turn.id)?.references).toContainEqual(expect.objectContaining({ kind: "attachment", label: "Visible history recovered after provider update" }));
    expect(queued.message.content).toBe("Continue the export.");
  });

  it("keeps recovered history after a failed fresh launch and runtime restart", async () => {
    const f = await fixture();
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    const first = f.resolve();
    const queued = f.store.beginAgentTurn(first.input);
    first.adopt(queued);
    f.store.settleAgentTurn(queued.turn.id, {
      status: "failed", terminalReason: "turn-start-failed",
      startedAt: queued.turn.requestedAt, completedAt: queued.turn.requestedAt,
      updatedAt: queued.turn.requestedAt,
    });
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const restarted = f.openStore();
    const next = f.resolve(restarted);
    const input = next.adopt(restarted.beginAgentTurn(next.input)).active.providerInput;
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain("The export must preserve accented names.");
    expect(input.prompt).not.toContain("OTHER_CHAT_PRIVATE_SENTINEL");
  });

  it.each(["backend", "endpoint", "unverified", "compatible"] as const)("does not automatically replay history across a %s boundary", async (boundary) => {
    const f = await fixture();
    const previous: typeof f.route.continuationIdentity = { ...f.previous };
    if (boundary === "backend") previous.backendConfigurationRevision += 1;
    if (boundary === "endpoint") previous.endpointIdentity = "different-account-endpoint";
    if (boundary === "unverified") previous.providerCompatibilityToken = undefined;
    if (boundary === "compatible") previous.providerCompatibilityToken = f.route.continuationIdentity.providerCompatibilityToken;
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: previous });
    const resolved = f.resolve();
    const input = resolved.adopt(f.store.beginAgentTurn(resolved.input)).active.providerInput;
    expect(input.prompt).not.toContain("The export must preserve accented names.");
    if (boundary === "compatible") expect(input.sessionId).toBe("before-update");
  });

  it("bounds long histories and marks both message and history truncation", async () => {
    const f = await fixture();
    for (let i = 0; i < 40; i += 1) {
      f.store.createMessage(f.conversation.id, `message-${i}: ${"🚀".repeat(4_000)}`, "user", [], null, new Date(Date.UTC(2030, 0, 2, 0, 0, i)).toISOString());
    }
    const history = f.store.continuationHistory(f.conversation.id);
    expect(history.truncated).toBe(true);
    expect(Buffer.byteLength(history.content, "utf8")).toBeLessThan(48 * 1_024);
    const parsed = JSON.parse(history.content);
    expect(parsed.messages.length).toBeLessThanOrEqual(24);
    expect(parsed.messages.at(-1).content).toContain("message-39:");
    expect(parsed.messages.every((message: { truncated: boolean }) => message.truncated)).toBe(true);
    expect(history.content).not.toContain("�");
  });
});
