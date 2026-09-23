import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { applyProjectAppearance, defaultProjectPreferences, parseProjectPreferences, projectAppearancePatchSchema, projectPreferencesSchema } from "../../src/shared/project-preferences";

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

  it("keeps preferences saved before the Claude spend limit existed, which defaults to no limit", () => {
    const { store, project, path, root } = fixture();
    // Exact shape written by builds that predate claudeMaxBudgetUsd.
    const legacy = { workspace: "worktree", autoPull: true, browserAccess: false, icon: { kind: "symbol", name: "code" },
      actions: [{ id: "11111111-1111-4111-8111-111111111111", name: "Check", executable: "node", args: ["--version"] }] };
    const appearanceDefaults = { color: null, colorEmphasis: "icon", pinned: false };
    expect(parseProjectPreferences(JSON.stringify(legacy))).toEqual({ ...legacy, claudeMaxBudgetUsd: null, ...appearanceDefaults });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const database = new Database(path);
    try { database.prepare("UPDATE projects SET preferences_json = ? WHERE id = ?").run(JSON.stringify(legacy), project.id); } finally { database.close(); }
    const reopened = new RuntimeStore(path, root); stores.push(reopened);
    expect(reopened.project(project.id).preferences).toEqual({ ...legacy, claudeMaxBudgetUsd: null, ...appearanceDefaults });
    reopened.updateProject(project.id, { preferences: { ...reopened.project(project.id).preferences!, claudeMaxBudgetUsd: 2.5 } });
    expect(reopened.project(project.id).preferences).toMatchObject({ autoPull: true, claudeMaxBudgetUsd: 2.5 });
  });

  it("bounds the Claude spend limit to positive cents up to 10,000 USD", () => {
    const defaults = defaultProjectPreferences();
    expect(defaults.claudeMaxBudgetUsd).toBeNull();
    for (const value of [null, 0.01, 0.29, 2.5, 10, 9_999.99, 10_000]) {
      expect(projectPreferencesSchema.safeParse({ ...defaults, claudeMaxBudgetUsd: value })).toMatchObject({ success: true, data: { claudeMaxBudgetUsd: value } });
    }
    for (const value of [0, -1, 0.001, 1.234, 10_000.01, Number.NaN, Number.POSITIVE_INFINITY, "5"]) {
      expect(projectPreferencesSchema.safeParse({ ...defaults, claudeMaxBudgetUsd: value }).success).toBe(false);
    }
    // A corrupt limit falls back to defaults, like any other corrupt preference.
    expect(parseProjectPreferences(JSON.stringify({ ...defaults, autoPull: true, claudeMaxBudgetUsd: -5 }))).toEqual(defaults);
  });

  it("persists project colour, emphasis and pinning across restart without touching other defaults", () => {
    const { store, project, path, root } = fixture();
    const preferences = { ...defaultProjectPreferences(), autoPull: true, icon: { kind: "symbol" as const, name: "code" as const },
      color: { kind: "palette" as const, name: "teal" as const }, colorEmphasis: "icon-and-name" as const, pinned: true };
    store.updateProject(project.id, { preferences });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new RuntimeStore(path, root); stores.push(reopened);
    expect(reopened.project(project.id).preferences).toEqual(preferences);
    reopened.updateProject(project.id, { preferences: applyProjectAppearance(reopened.project(project.id).preferences, { color: { kind: "custom", value: "#3a86ff" } }) });
    expect(reopened.project(project.id).preferences).toEqual({ ...preferences, color: { kind: "custom", value: "#3a86ff" } });
  });

  it("validates project colours strictly and normalises custom hex case", () => {
    const defaults = defaultProjectPreferences();
    expect(defaults).toMatchObject({ color: null, colorEmphasis: "icon", pinned: false });
    expect(projectPreferencesSchema.parse({ ...defaults, color: { kind: "custom", value: "#3A86FF" } }).color).toEqual({ kind: "custom", value: "#3a86ff" });
    for (const color of [{ kind: "palette", name: "chartreuse" }, { kind: "custom", value: "#abc" }, { kind: "custom", value: "red" },
      { kind: "custom", value: "#3a86ff", extra: true }, { kind: "gradient", value: "#3a86ff" }, "#3a86ff"]) {
      expect(projectPreferencesSchema.safeParse({ ...defaults, color }).success).toBe(false);
    }
    expect(projectPreferencesSchema.safeParse({ ...defaults, colorEmphasis: "row" }).success).toBe(false);
    expect(projectPreferencesSchema.safeParse({ ...defaults, pinned: "yes" }).success).toBe(false);
  });

  it("resets only a corrupt appearance field and keeps every other stored preference", () => {
    const stored = { ...defaultProjectPreferences(), autoPull: true, icon: { kind: "symbol", name: "globe" }, pinned: true,
      color: { kind: "custom", value: "javascript:alert(1)" }, colorEmphasis: "everything" };
    expect(parseProjectPreferences(JSON.stringify(stored))).toEqual({ ...defaultProjectPreferences(), autoPull: true,
      icon: { kind: "symbol", name: "globe" }, pinned: true });
    expect(parseProjectPreferences({ ...stored, actions: "broken" })).toEqual(defaultProjectPreferences());
    expect(parseProjectPreferences([stored])).toEqual(defaultProjectPreferences());
  });

  it("accepts only non-empty, well-formed appearance patches and merges them over current preferences", () => {
    expect(projectAppearancePatchSchema.safeParse({}).success).toBe(false);
    expect(projectAppearancePatchSchema.safeParse({ color: { kind: "palette", name: "blue" } }).success).toBe(true);
    expect(projectAppearancePatchSchema.safeParse({ color: null, pinned: false }).success).toBe(true);
    expect(projectAppearancePatchSchema.safeParse({ actions: [] }).success).toBe(false);
    expect(projectAppearancePatchSchema.safeParse({ colorEmphasis: "row" }).success).toBe(false);
    const current = { ...defaultProjectPreferences(), autoPull: true, colorEmphasis: "icon-and-name" as const };
    expect(applyProjectAppearance(current, { color: { kind: "palette", name: "red" } }))
      .toEqual({ ...current, color: { kind: "palette", name: "red" } });
    expect(applyProjectAppearance(undefined, { pinned: true })).toEqual({ ...defaultProjectPreferences(), pinned: true });
  });
});
