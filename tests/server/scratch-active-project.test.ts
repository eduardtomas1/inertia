import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { GitError } from "../../src/server/git/types";
import { runGitInspection } from "../../src/server/git/runner";
import { ScratchWorkspace } from "../../src/server/runtime/scratch-workspace";

vi.mock("../../src/server/git/runner", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/git/runner")>(),
  runGitInspection: vi.fn(),
}));

let root: string;
let data: string;
let store: RuntimeStore;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-scratch-active-")));
  data = join(root, "data");
  mkdirSync(data);
  store = new RuntimeStore(join(data, "inertia.sqlite"), data);
  vi.mocked(runGitInspection).mockReset().mockRejectedValue(new GitError("not-repository", "No Git repository"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function onlyScratchChat() {
  const workspace = new ScratchWorkspace(store, data);
  const project = await workspace.ensureProject();
  const chat = await workspace.createConversation(project.id, "Only", {});
  store.selectConversation(chat.id);
  return { project, chat };
}

function userProject(name: string) {
  const folder = join(root, name);
  mkdirSync(folder);
  return store.createProject(name, folder);
}

describe("the managed project is never active without a chat", () => {
  it.each(["delete", "archive"] as const)("%s of the only no-project chat selects a real project", async (action) => {
    const user = userProject("user");
    const userChat = store.createConversation(user.id, "User chat", { activate: false });
    const { project, chat } = await onlyScratchChat();
    expect(store.shellSnapshot()).toMatchObject({ activeProjectId: project.id, activeConversationId: chat.id });
    if (action === "delete") store.deleteConversation(chat.id);
    else store.archiveConversation(chat.id, true);
    expect(store.shellSnapshot()).toMatchObject({ activeProjectId: user.id, activeConversationId: userChat.id });
  });

  it("leaves nothing selected when no real project exists", async () => {
    const { chat } = await onlyScratchChat();
    store.deleteConversation(chat.id);
    expect(store.shellSnapshot()).toMatchObject({ activeProjectId: null, activeConversationId: null });
  });

  it("keeps a remaining no-project chat selected after deleting another", async () => {
    const { project, chat } = await onlyScratchChat();
    const other = await new ScratchWorkspace(store, data).createConversation(project.id, "Other", { activate: false });
    store.deleteConversation(chat.id);
    expect(store.shellSnapshot()).toMatchObject({ activeProjectId: project.id, activeConversationId: other.id });
  });

  it("does not pick the managed project after removing the active project", async () => {
    const a = userProject("a");
    const b = userProject("b");
    const project = await new ScratchWorkspace(store, data).ensureProject();
    const chat = await new ScratchWorkspace(store, data).createConversation(project.id, "Recent", { activate: false });
    await new Promise((done) => setTimeout(done, 5));
    store.createMessage(chat.id, "hello", "user", [], null, undefined, { activateConversation: false });
    store.selectProject(a.id);
    store.removeProject(a.id);
    expect(store.shellSnapshot().activeProjectId).toBe(b.id);
  });

  it("does not select the managed project without a chat", async () => {
    const user = userProject("user");
    const project = await new ScratchWorkspace(store, data).ensureProject();
    store.selectProject(project.id);
    expect(store.shellSnapshot()).toMatchObject({ activeProjectId: user.id, activeConversationId: null });
  });
});
