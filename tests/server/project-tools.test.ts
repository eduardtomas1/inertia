import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { ProjectToolsController } from "../../src/server/runtime/project-tools-controller";
import { projectToolDraftSchema, type ProjectToolDraft } from "../../src/shared/project-tools";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";

const draft: ProjectToolDraft = { name: "Documentation", url: "https://docs.example.com/mcp", bearerTokenEnv: null, providers: ["claude", "codex"] };
const roots: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(removePortableFixture)); });
function fixture() {
  const root = portableFixtureRoot("project tools"); roots.push(root);
  const path = join(root, "inertia.sqlite");
  const store = new RuntimeStore(path, root); stores.push(store);
  const project = store.createProject("Tools", root);
  const chat = store.createConversation(project.id, "First chat", { providerId: "codex" });
  const otherChat = store.createConversation(project.id, "Second chat", { providerId: "codex" });
  const controller = new ProjectToolsController(store);
  const connection = () => store.projectTools.list(project.id)[0]!;
  const view = () => controller.view(project.id, chat.id).connections[0]!;
  return { root, path, store, project, chat, otherChat, controller, connection, view };
}

describe("project tool configuration and exact-run evidence", () => {
  it("upgrades a released schema and persists configuration, with optimistic edits and project ownership", () => {
    const root = portableFixtureRoot("project tools migration"); roots.push(root);
    const path = join(root, "inertia.sqlite");
    const old = new Database(path); migrateRuntimeDatabase(old, 85); old.close();
    const store = new RuntimeStore(path, root); stores.push(store);
    const project = store.createProject("Docs", root);
    store.projectTools.save(project.id, draft);
    const saved = store.projectTools.list(project.id)[0]!;
    store.projectTools.save(project.id, { ...draft, name: "Updated" }, saved.id, saved.revision);
    expect(() => store.projectTools.save(project.id, draft, saved.id, saved.revision)).toThrow("changed");
    expect(() => store.projectTools.remove(randomUUID(), saved.id, 2)).toThrow("changed");
    expect(() => store.projectTools.remove(project.id, saved.id, 1)).toThrow("changed");
    const reopened = new RuntimeStore(path, root, { recoverInterruptedRuns: false }); stores.push(reopened);
    expect(reopened.projectTools.list(project.id)).toEqual([{ ...saved, name: "Updated", revision: 2 }]);
    reopened.projectTools.remove(project.id, saved.id, 2);
    expect(store.projectTools.list(project.id)).toEqual([]);
  });

  it("does not reuse one chat's observations in another chat, run, project, or restarted runtime", () => {
    const f = fixture(); f.store.projectTools.save(f.project.id, draft);
    const first = f.controller.begin(f.chat, "run-1")!;
    first.report({ id: f.connection().id, state: "available", reason: "Confirmed", toolNames: ["search"] });
    expect(f.view().state).toBe("available");
    expect(f.controller.view(f.project.id, f.otherChat.id).connections[0]?.state).toBe("configured");
    const second = f.controller.begin(f.chat, "run-2")!;
    first.report({ id: f.connection().id, state: "available", reason: "Stale", toolNames: ["stale"] });
    f.controller.finish(f.chat.id, "run-1");
    expect(f.view().state).toBe("configured");
    second.report({ id: randomUUID(), state: "available", reason: "Wrong server", toolNames: ["wrong"] });
    expect(f.view().state).toBe("configured");
    second.report({ id: f.connection().id, state: "available", reason: "Confirmed", toolNames: ["search"] });
    expect(new ProjectToolsController(f.store).view(f.project.id, f.chat.id).connections[0]?.state).toBe("configured");
    mkdirSync(join(f.root, "foreign"));
    const foreignProject = f.store.createProject("Foreign", join(f.root, "foreign"));
    expect(() => f.controller.view(foreignProject.id, f.chat.id)).toThrow("does not belong");
    f.controller.finish(f.chat.id, "run-2");
    expect(f.view()).toMatchObject({ state: "configured", toolNames: [], checkedAt: null });
  });

  it("marks edits, newly added connections and provider disabling as requiring a new run", () => {
    const f = fixture(); f.controller.begin(f.chat, "empty-run");
    f.store.projectTools.save(f.project.id, draft);
    expect(f.view().state).toBe("needs-restart");
    f.controller.begin(f.chat, "configured-run");
    const saved = f.connection();
    expect(() => f.controller.assertRemovable(f.project.id, saved.id)).toThrow("running chat");
    f.store.projectTools.save(f.project.id, { ...draft, providers: ["claude"] }, saved.id, saved.revision);
    expect(f.view().state).toBe("needs-restart");
    f.controller.finish(f.chat.id, "configured-run");
    expect(f.view().state).toBe("unsupported");
    expect(() => f.controller.assertRemovable(f.project.id, saved.id)).not.toThrow();
  });

  it("deduplicates refreshes and drops evidence if the chat finishes during a status request", async () => {
    const f = fixture(); f.store.projectTools.save(f.project.id, draft);
    const run = f.controller.begin(f.chat, "run")!;
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => { resolve = () => {
      run.report({ id: f.connection().id, state: "available", reason: "Confirmed", toolNames: ["search"] }); done();
    }; }));
    run.setRefresh!(refresh);
    const first = f.controller.refresh(f.project.id, f.chat.id);
    const second = f.controller.refresh(f.project.id, f.chat.id);
    expect(refresh).toHaveBeenCalledTimes(1);
    f.controller.finish(f.chat.id, "run"); resolve(); await Promise.all([first, second]);
    expect(f.view().state).toBe("configured");
  });

  it("rejects embedded secrets, unsupported transports, invalid provider sets and raw authentication fields", () => {
    for (const url of ["stdio://node", "http://remote.example/mcp", "https://user:password@example.com/mcp", "https://example.com/mcp?token=value", "https://example.com/mcp#secret"]) {
      expect(projectToolDraftSchema.safeParse({ ...draft, url }).success).toBe(false);
    }
    for (const extra of [{ headers: { Authorization: "synthetic" } }, { bearerTokenEnv: "ANTHROPIC_API_KEY" }, { providers: ["cursor"] }, { providers: [] }, { providers: ["codex", "codex"] }]) {
      expect(projectToolDraftSchema.safeParse({ ...draft, ...extra }).success).toBe(false);
    }
    expect(projectToolDraftSchema.safeParse({ ...draft, url: "http://[::1]:3333/mcp", bearerTokenEnv: "INERTIA_MCP_DOCS" }).success).toBe(true);
  });
});
