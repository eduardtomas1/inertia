import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { ConversationUpdateService } from "../../src/server/runtime/conversation-update-service";
import { projectDetachedChatSnapshot } from "../../src/server/runtime/detached-chat-runtime-projection";
import { defaultSettings } from "../../src/shared/contracts/app";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import { defaultRoutingSettings, type RoutingPreset } from "../../src/shared/routing/routing-policy";
import { RESTORE_DEFAULTS_RESETS, restoredDefaultSettings } from "../../src/shared/restore-defaults";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];
const preset: RoutingPreset = {
  providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-5.6", reasoningEffort: "high", fastMode: false, weight: "prefer",
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore(): Promise<{ databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-routing-settings-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  return { databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

describe("routing settings persistence", () => {
  it("round-trips settings.update payloads across restart and merges tiers", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    expect(store.snapshot().settings.routing).toEqual(defaultRoutingSettings());
    const command = clientCommandSchema.parse({
      type: "settings.update",
      requestId: crypto.randomUUID(),
      payload: { routing: { enabled: true, confidenceThreshold: 0.65, tiers: { heavy: { presets: [preset] } } } },
    });
    if (command.type !== "settings.update") throw new Error("Expected a settings command.");
    store.updateSettings(command.payload);
    store.updateSettings({ routing: { stickiness: "rebalance", tiers: { light: { presets: [] } } } });
    store.updateSettings({ theme: "dark" });
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.routing).toEqual({
      ...defaultRoutingSettings(),
      enabled: true,
      confidenceThreshold: 0.65,
      stickiness: "rebalance",
      tiers: { ...defaultRoutingSettings().tiers, heavy: { presets: [preset] }, light: { presets: [] } },
    });
    expect(reopened.settings.current().routing.enabled).toBe(true);
    reopened.updateSettings(restoredDefaultSettings(reopened.settings.current()));
    expect(reopened.snapshot().settings.routing).toEqual(defaultRoutingSettings());
    expect(RESTORE_DEFAULTS_RESETS.some(({ keys }) => (keys as readonly string[]).includes("routing"))).toBe(true);
    reopened.close();
  });

  it("repairs corrupt stored settings and bounds the column", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    store.close();
    const database = new Database(databasePath);
    database.prepare("UPDATE app_state SET routing_settings_json = ? WHERE id = 1")
      .run(JSON.stringify({ enabled: true, picker: "unknown", tiers: { max: { presets: [{ ...preset, weight: "x" }] } } }));
    expect(() => database.prepare("UPDATE app_state SET routing_settings_json = ? WHERE id = 1")
      .run(`"${"x".repeat(65_536)}"`)).toThrow(/CHECK constraint/u);
    database.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.snapshot().settings.routing).toEqual({ ...defaultRoutingSettings(), enabled: true });
    reopened.close();
  });

  it("validates routing in snapshots while tolerating legacy settings", () => {
    const snapshotEvent = (settings: unknown, conversations: unknown[] = []): unknown => ({
      type: "snapshot.updated",
      snapshot: { projects: [], conversations, runs: [], providers: [], settings, activeProjectId: null, activeConversationId: null },
    });
    const { routing: _routing, ...legacy } = defaultSettings;
    expect(parseServerEvent(snapshotEvent(defaultSettings))).toBeTruthy();
    const completed = parseServerEvent(snapshotEvent(legacy));
    expect(completed.type === "snapshot.updated" && completed.snapshot.settings.routing).toEqual(defaultRoutingSettings());
    expect(() => parseServerEvent(snapshotEvent({ ...defaultSettings, routing: { ...defaultRoutingSettings(), picker: "jev" } })))
      .toThrow("Malformed server event");
  });
});

describe("conversation routing mode", () => {
  it("persists per chat, defaults to manual and refuses unknown values", async () => {
    const { databasePath, workspacePath, store } = await openStore();
    const project = store.createProject("Routing", workspacePath);
    const manual = store.createConversation(project.id, "Manual");
    const auto = store.createConversation(project.id, "Auto", { routingMode: "auto" });
    expect(manual.routingMode).toBe("manual");
    expect(store.conversation(auto.id).routingMode).toBe("auto");
    store.updateConversation(manual.id, { routingMode: "auto" });
    store.close();
    const database = new Database(databasePath);
    expect(() => database.prepare("UPDATE conversations SET routing_mode = 'sometimes' WHERE id = ?").run(manual.id))
      .toThrow(/CHECK constraint/u);
    expect((database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_turns'").get() as { sql: string }).sql)
      .toContain("length(routing_json) <= 4096");
    database.close();
    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.conversation(manual.id).routingMode).toBe("auto");
    expect(reopened.shellSnapshot().conversations.find(({ id }) => id === auto.id)?.routingMode).toBe("auto");
    reopened.close();
  });

  it("returns an Auto chat to manual when the user picks a model, and keeps Auto for routed updates", async () => {
    const { workspacePath, store } = await openStore();
    const project = store.createProject("Routing", workspacePath);
    const conversation = store.createConversation(project.id, "Auto", {
      routingMode: "auto",
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
    });
    const updates = new ConversationUpdateService({
      store,
      providers: { resolveModelRoute: resolveNativeModelRoute },
      backendProfileController: {
        validateSelection: (selection) => selection,
        isExternalSelection: () => false,
        supportsNativeFastModeControl: () => false,
      },
    });
    const selection = modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.6", reasoningEffort: "high" }));
    expect(updates.update({ conversationId: conversation.id, modelSelection: selection }, "auto-routing").routingMode).toBe("auto");
    expect(updates.update({ conversationId: conversation.id, reasoningEffort: "low" }).routingMode).toBe("manual");
    expect(updates.update({ conversationId: conversation.id, routingMode: "auto" }).routingMode).toBe("auto");
    expect(updates.update({ conversationId: conversation.id, modelSelection: selection, routingMode: "auto" }).routingMode).toBe("auto");
    expect(updates.update({ conversationId: conversation.id, title: "Renamed" }).routingMode).toBe("auto");
    store.close();
  });

  it("accepts routingMode on conversation.update and conversation.create but not on Duo sides", () => {
    const conversationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const parse = (type: string, payload: unknown) => clientCommandSchema.safeParse({ type, requestId: crypto.randomUUID(), payload }).success;
    expect(parse("conversation.update", { conversationId, routingMode: "auto" })).toBe(true);
    expect(parse("conversation.update", { conversationId, routingMode: "always" })).toBe(false);
    expect(parse("conversation.create", { projectId, title: "New", routingMode: "auto" })).toBe(true);
    expect(parse("todo.start", { id: crypto.randomUUID(), conversation: { projectId, routingMode: "manual" } })).toBe(true);
  });

  it("only projects the Auto switch into detached chats", async () => {
    const { store } = await openStore();
    store.updateSettings({ routing: { enabled: true, tiers: { heavy: { presets: [preset] } } } });
    const projected = projectDetachedChatSnapshot(store.shellSnapshot(), crypto.randomUUID());
    expect(projected.settings.routing).toEqual({ ...defaultRoutingSettings(), enabled: true });
    store.close();
  });
});

describe("routing migration", () => {
  it("upgrades the oldest released fixture with manual chats and default routing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-routing-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "v0.0.1.sqlite");
    await copyFile(resolve("tests/fixtures/database/v0.0.1.sqlite"), databasePath);
    const database = new Database(databasePath);
    database.pragma("foreign_keys = ON");
    migrateRuntimeDatabase(database);
    const columns = (table: string) => new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name));
    expect(columns("app_state").has("routing_settings_json")).toBe(true);
    expect(columns("conversations").has("routing_mode")).toBe(true);
    expect(columns("agent_turns").has("routing_json")).toBe(true);
    const { count } = database.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number };
    expect(count).toBeGreaterThan(0);
    expect(database.prepare("SELECT DISTINCT routing_mode AS mode FROM conversations").all()).toEqual([{ mode: "manual" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM agent_turns WHERE routing_json IS NOT NULL").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT routing_settings_json AS json FROM app_state WHERE id = 1").get()).toEqual({ json: "{}" });
    database.close();
  });
});
