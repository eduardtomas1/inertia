import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationWorkAuthority } from "../../src/server/runtime/conversation-work-authority";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("conversation work authority", () => {
  it("serializes conversations that resolve to the same canonical checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-work-authority-"));
    temporaryDirectories.push(root);
    const checkout = join(root, "checkout");
    const alias = join(root, "checkout-alias");
    await mkdir(checkout);
    await symlink(
      checkout,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const workspaces = new Map([
      ["conversation-a", { projectId: "project", checkoutPath: checkout }],
      ["conversation-b", { projectId: "second-project", checkoutPath: alias }],
    ]);
    const authority = new ConversationWorkAuthority((conversationId) =>
      workspaces.get(conversationId)!);

    expect(authority.reserve("conversation-a")).toBe(true);
    expect(authority.reserve("conversation-b")).toBe(false);
    expect(authority.hasConversation("conversation-b")).toBe(true);
    expect(authority.hasCheckout(alias)).toBe(true);

    authority.release("conversation-a");
    expect(authority.reserve("conversation-b")).toBe(true);
  });

  it("allows distinct worktrees while retaining project-level authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-work-authority-"));
    temporaryDirectories.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    const workspaces = new Map([
      ["conversation-a", { projectId: "project", checkoutPath: first }],
      ["conversation-b", { projectId: "project", checkoutPath: second }],
    ]);
    const authority = new ConversationWorkAuthority((conversationId) =>
      workspaces.get(conversationId)!);

    expect(authority.reserve("conversation-a")).toBe(true);
    expect(authority.reserve("conversation-b")).toBe(true);
    expect(authority.hasProject("project")).toBe(true);

    authority.clear();
    expect(authority.hasConversation("conversation-a")).toBe(false);
    expect(authority.hasConversation("conversation-b")).toBe(false);
    expect(authority.hasProject("project")).toBe(false);
  });
});
