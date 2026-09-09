import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { defaultProjectPreferences, parseProjectPreferences, projectPreferencesSchema } from "../../src/shared/project-preferences";

const roots: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-project-preferences-")); roots.push(root);
  const path = join(root, "inertia.sqlite");
  const store = new RuntimeStore(path, root); stores.push(store);
  const project = store.createProject("Studio", root);
  const conversation = store.createConversation(project.id, "Original");
  return { root, path, store, project, conversation };
}

describe("durable project and thread organization", () => {
  it("upgrades main's schema without changing the selected color family", () => {
    const database = new Database(":memory:");
    try {
      migrateRuntimeDatabase(database, 71);
      database.prepare("INSERT INTO app_state (id, theme, compact_sidebar, show_timestamps, terminal_font_size, color_theme) VALUES (1, 'system', 0, 1, 13, 'ocean')").run();
      migrateRuntimeDatabase(database);
      expect(database.prepare("SELECT light_color_theme, dark_color_theme FROM app_state").get())
        .toEqual({ light_color_theme: "ocean", dark_color_theme: "ocean" });
      expect(database.prepare("SELECT name FROM pragma_table_info('projects') WHERE name = 'preferences_json'").get()).toBeDefined();
      migrateRuntimeDatabase(database); // Reopen is idempotent.
    } finally { database.close(); }
  });

  it("persists independent themes, and a whole-card update replaces both", () => {
    const { store, path, root } = fixture();
    store.updateSettings({ colorTheme: "ocean" });
    store.updateSettings({ lightColorTheme: "grove" });
    expect(store.shellSnapshot().settings).toMatchObject({ lightColorTheme: "grove", darkColorTheme: "ocean" });
    store.updateSettings({ darkColorTheme: "iris" });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new RuntimeStore(path, root); stores.push(reopened);
    expect(reopened.shellSnapshot().settings).toMatchObject({ lightColorTheme: "grove", darkColorTheme: "iris" });
    reopened.updateSettings({ colorTheme: "ember" });
    expect(reopened.shellSnapshot().settings).toMatchObject({ lightColorTheme: "ember", darkColorTheme: "ember" });
  });

  it("retains project defaults and explicit unread state across restart without changing run state", () => {
    const { store, project, conversation, path, root } = fixture();
    const preferences = { ...defaultProjectPreferences(), workspace: "worktree" as const, browserAccess: false, icon: { kind: "symbol" as const, name: "code" as const } };
    store.updateProject(project.id, { preferences });
    store.markConversationUnread(conversation.id);
    expect(store.conversation(conversation.id)).toMatchObject({ status: "idle", attentionKind: null, completedAt: null, markedUnreadAt: expect.any(String) });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new RuntimeStore(path, root); stores.push(reopened);
    expect(reopened.project(project.id).preferences).toEqual(preferences);
    expect(reopened.conversation(conversation.id).markedUnreadAt).toEqual(expect.any(String));
    reopened.selectConversation(conversation.id);
    expect(reopened.conversation(conversation.id).markedUnreadAt).toBeNull();
    reopened.markConversationUnread(conversation.id);
    reopened.settleConversation(conversation.id, true);
    expect(reopened.conversation(conversation.id).markedUnreadAt).toBeNull();
  });

  it("regenerates a bounded local title from the latest user text, never the assistant response", () => {
    const { store, conversation } = fixture();
    expect(() => store.regenerateConversationTitle(conversation.id)).toThrow(/text message/u);
    store.createMessage(conversation.id, "Earlier", "user", [], null, "2026-09-09T09:00:00.000Z");
    store.createMessage(conversation.id, `  Latest\n  request ${"x".repeat(200)}`, "user", [], null, "2026-09-09T09:01:00.000Z");
    store.createMessage(conversation.id, "Assistant output must not become a title", "assistant", [], null, "2026-09-09T09:02:00.000Z");
    store.regenerateConversationTitle(conversation.id);
    expect(store.conversation(conversation.id).title).toBe(`Latest request ${"x".repeat(200)}`.slice(0, 64));
    expect(store.conversation(conversation.id).status).toBe("idle");
    store.updateConversation(conversation.id, { status: "running" });
    expect(() => store.regenerateConversationTitle(conversation.id)).toThrow(/active work/u);
  });

  it("rejects unbounded and malformed settings, duplicate action IDs and executable control characters", () => {
    const defaults = defaultProjectPreferences();
    expect(projectPreferencesSchema.safeParse({ ...defaults, unknown: true }).success).toBe(false);
    expect(projectPreferencesSchema.safeParse({ ...defaults, icon: { kind: "image", data: "data:image/svg+xml,<script/>" } }).success).toBe(false);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    const imagePreferences = () => ({ ...defaults, icon: { kind: "image", data: `data:image/png;base64,${png.toString("base64")}` } });
    expect(projectPreferencesSchema.safeParse(imagePreferences()).success).toBe(true);
    png.writeUInt32BE(100_000, 16);
    expect(projectPreferencesSchema.safeParse(imagePreferences()).success).toBe(false);
    const action = { id: "11111111-1111-4111-8111-111111111111", name: "Check", executable: "node", args: ["literal; $(not-executed)"] };
    expect(projectPreferencesSchema.safeParse({ ...defaults, actions: [action] }).success).toBe(true);
    expect(projectPreferencesSchema.safeParse({ ...defaults, actions: [action, action] }).success).toBe(false);
    expect(projectPreferencesSchema.safeParse({ ...defaults, actions: [{ ...action, executable: "node\nsecond" }] }).success).toBe(false);
    expect(projectPreferencesSchema.safeParse({ ...defaults, actions: [{ ...action, args: Array.from({ length: 64 }, () => "😀".repeat(1800)) }] }).success).toBe(false);
    expect(parseProjectPreferences("{broken")).toEqual(defaults);
    expect(parseProjectPreferences("x".repeat(200_000))).toEqual(defaults);
  });
});
