import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import { clientCommandSchema } from "../../src/shared/contracts";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";
import { MAX_TERMINAL_PATH_TEXT_LENGTH } from "../../src/shared/contracts/terminal-links";
import { createTerminalLinkCommandHandler } from "../../src/server/runtime/commands/terminal-link-commands";
import {
  parseTerminalPathReference,
  resolveTerminalPath,
  workspaceRelativeCandidate,
} from "../../src/server/terminal-path-links";

const requestId = "00000000-0000-4000-8000-000000000001";
const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

let root: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "inertia-terminal-links-")));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  await mkdir(join(workspace, "src", "nested"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "src", "app.ts"), "one\ntwo\n");
  await writeFile(join(workspace, "src", "nested", "deep.test.ts"), "x\n");
  await writeFile(join(workspace, "README.md"), "# hi\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("terminal path references", () => {
  it.each([
    ["src/app.ts", { path: "src/app.ts", line: null, column: null }],
    ["src/app.ts:12", { path: "src/app.ts", line: 12, column: null }],
    ["src/app.ts:12:3", { path: "src/app.ts", line: 12, column: 3 }],
    ["src/app.ts(12,3)", { path: "src/app.ts", line: 12, column: 3 }],
    ["src/app.ts(7)", { path: "src/app.ts", line: 7, column: null }],
    ["C:\\repo\\src\\app.ts:4:2", { path: "C:\\repo\\src\\app.ts", line: 4, column: 2 }],
    ["C:\\repo\\src\\app.ts", { path: "C:\\repo\\src\\app.ts", line: null, column: null }],
  ])("parses %s", (text, expected) => {
    expect(parseTerminalPathReference(text)).toEqual(expected);
  });

  it.each([
    "",
    "https://example.com/src/app.ts",
    "~/secrets.txt",
    "src/app.ts:0",
    "src/app.ts:1:0",
    "src/\u0000app.ts",
    "src/app.ts\n",
    "x".repeat(MAX_TERMINAL_PATH_TEXT_LENGTH + 1),
  ])("refuses %j", (text) => {
    expect(parseTerminalPathReference(text)).toBeNull();
  });
});

describe("workspace-relative candidates", () => {
  it("maps Windows separators, drives and UNC roots lexically", () => {
    const bases = ["C:\\work\\repo"];
    expect(workspaceRelativeCandidate("src\\app.ts", bases, "win32")).toBe("src/app.ts");
    expect(workspaceRelativeCandidate("src/nested\\deep.ts", bases, "win32")).toBe("src/nested/deep.ts");
    expect(workspaceRelativeCandidate("C:\\work\\repo\\src\\app.ts", bases, "win32")).toBe("src/app.ts");
    expect(workspaceRelativeCandidate("c:/WORK/repo/src/app.ts", bases, "win32")).toBe("src/app.ts");
    expect(workspaceRelativeCandidate("D:\\work\\repo\\src\\app.ts", bases, "win32")).toBeNull();
    expect(workspaceRelativeCandidate("..\\other\\app.ts", bases, "win32")).toBeNull();
    expect(workspaceRelativeCandidate("\\work\\repo\\app.ts", bases, "win32")).toBeNull();
    expect(workspaceRelativeCandidate("C:app.ts", bases, "win32")).toBeNull();
    expect(workspaceRelativeCandidate("\\\\?\\C:\\work\\repo\\app.ts", bases, "win32")).toBeNull();
    expect(workspaceRelativeCandidate("\\\\server\\share\\repo\\app.ts", ["\\\\server\\share\\repo"], "win32"))
      .toBe("app.ts");
    expect(workspaceRelativeCandidate("C:\\work\\repo", bases, "win32")).toBeNull();
  });

  it("maps POSIX absolute and relative paths and refuses escapes", () => {
    const bases = ["/private/tmp/repo", "/tmp/repo"];
    expect(workspaceRelativeCandidate("src/app.ts", bases, "linux")).toBe("src/app.ts");
    expect(workspaceRelativeCandidate("./src/app.ts", bases, "linux")).toBe("src/app.ts");
    expect(workspaceRelativeCandidate("/tmp/repo/src/app.ts", bases, "darwin")).toBe("src/app.ts");
    expect(workspaceRelativeCandidate("/private/tmp/repo/src/app.ts", bases, "darwin")).toBe("src/app.ts");
    expect(workspaceRelativeCandidate("../other/app.ts", bases, "linux")).toBeNull();
    expect(workspaceRelativeCandidate("/etc/passwd", bases, "linux")).toBeNull();
    expect(workspaceRelativeCandidate("/tmp/repository/app.ts", bases, "linux")).toBeNull();
  });
});

describe("resolveTerminalPath", () => {
  it("resolves existing workspace files with their location", async () => {
    await expect(resolveTerminalPath(workspace, "src/app.ts:2:3")).resolves.toEqual({
      projectPath: "src/app.ts", line: 2, column: 3,
    });
    await expect(resolveTerminalPath(workspace, "README.md")).resolves.toEqual({
      projectPath: "README.md", line: null, column: null,
    });
    await expect(resolveTerminalPath(workspace, `${join(workspace, "src", "nested", "deep.test.ts")}:9`))
      .resolves.toEqual({ projectPath: "src/nested/deep.test.ts", line: 9, column: null });
    await expect(resolveTerminalPath(workspace, "src/nested/../app.ts(4,1)")).resolves.toEqual({
      projectPath: "src/app.ts", line: 4, column: 1,
    });
  });

  it("returns null for missing files, folders and paths outside the workspace", async () => {
    await expect(resolveTerminalPath(workspace, "src/missing.ts:1")).resolves.toBeNull();
    await expect(resolveTerminalPath(workspace, "src")).resolves.toBeNull();
    await expect(resolveTerminalPath(workspace, "../outside/secret.txt")).resolves.toBeNull();
    await expect(resolveTerminalPath(workspace, join(outside, "secret.txt"))).resolves.toBeNull();
    await expect(resolveTerminalPath(join(root, "missing-workspace"), "src/app.ts")).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses symbolic links that escape and canonicalizes ones that stay inside", async () => {
    await symlink(join(outside, "secret.txt"), join(workspace, "escape.txt"));
    await symlink(outside, join(workspace, "linked-outside"));
    await symlink(join(workspace, "src", "app.ts"), join(workspace, "alias.ts"));
    await expect(resolveTerminalPath(workspace, "escape.txt")).resolves.toBeNull();
    await expect(resolveTerminalPath(workspace, "linked-outside/secret.txt:1")).resolves.toBeNull();
    await expect(resolveTerminalPath(workspace, "alias.ts:2")).resolves.toEqual({
      projectPath: "src/app.ts", line: 2, column: null,
    });
  });

  it.skipIf(process.platform === "win32")("accepts absolute paths spelled through a linked workspace root", async () => {
    const alias = join(root, "alias-root");
    await symlink(workspace, alias);
    await expect(resolveTerminalPath(alias, join(workspace, "src", "app.ts"))).resolves.toEqual({
      projectPath: "src/app.ts", line: null, column: null,
    });
    await expect(resolveTerminalPath(alias, `${join(alias, "README.md")}:1`)).resolves.toEqual({
      projectPath: "README.md", line: 1, column: null,
    });
  });
});

describe("workspace.path.resolve command", () => {
  it("bounds its input at the contract boundary", () => {
    const valid = { type: "workspace.path.resolve", requestId, payload: { projectId, conversationId, text: "src/app.ts:1" } };
    expect(clientCommandSchema.safeParse(valid).success).toBe(true);
    for (const text of ["", "x".repeat(MAX_TERMINAL_PATH_TEXT_LENGTH + 1), "src/a.ts\n", "a\u001b[31m.ts"]) {
      expect(clientCommandSchema.safeParse({ ...valid, payload: { ...valid.payload, text } }).success).toBe(false);
    }
    expect(clientCommandSchema.safeParse({ ...valid, payload: { ...valid.payload, path: "/etc" } }).success).toBe(false);
  });

  it("validates results at the runtime boundary", () => {
    const event = (resolution: unknown) => ({ type: "request.result", requestId, result: { kind: "workspace.path", resolution } });
    expect(serverEventSchema.safeParse(event(null)).success).toBe(true);
    expect(serverEventSchema.safeParse(event({ projectPath: "src/app.ts", line: 3, column: null })).success).toBe(true);
    for (const resolution of [
      { projectPath: "../secret", line: null, column: null },
      { projectPath: "/etc/passwd", line: null, column: null },
      { projectPath: "C:/secret", line: null, column: null },
      { projectPath: "src\\app.ts", line: null, column: null },
      { projectPath: "src/app.ts", line: 0, column: null },
      { projectPath: "src/app.ts", line: null, column: 2 },
      { projectPath: "src/app.ts", line: 1, column: null, extra: true },
    ]) {
      expect(serverEventSchema.safeParse(event(resolution)).success).toBe(false);
    }
  });

  it("resolves inside the chat's workspace and answers the request", async () => {
    const send = vi.fn<(socket: unknown, event: ServerEvent) => void>();
    const workspacePath = vi.fn(() => workspace);
    const handler = createTerminalLinkCommandHandler({ workspacePath, send });
    const command = clientCommandSchema.parse({
      type: "workspace.path.resolve", requestId, payload: { projectId, conversationId, text: "src/app.ts:1:2" },
    }) as ClientCommand;
    await expect(handler({} as never, command)).resolves.toBe("handled");
    expect(workspacePath).toHaveBeenCalledWith(projectId, conversationId);
    expect(send).toHaveBeenCalledWith({}, {
      type: "request.result",
      requestId,
      result: { kind: "workspace.path", resolution: { projectPath: "src/app.ts", line: 1, column: 2 } },
    });
    expect(handler.commandTypes).toEqual(["workspace.path.resolve"]);
  });
});
