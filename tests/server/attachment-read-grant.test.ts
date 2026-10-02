// @inertia-test-suite portable
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  acpAttachmentReadAllowed,
  claudeAttachmentReadAllowed,
  claudePermissionAccess,
  isOwnAttachmentPath,
  openCodeAttachmentReadAllowed,
} from "../../src/server/provider/attachment-read-grant";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

async function store() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-attachment-grant-")));
  roots.push(root);
  const own = join(root, "11111111-1111-4111-8111-111111111111");
  const sibling = join(root, "22222222-2222-4222-8222-222222222222");
  await mkdir(own);
  await mkdir(sibling);
  const file = join(own, "11111111-1111-4111-8111-111111111111.log");
  const other = join(sibling, "22222222-2222-4222-8222-222222222222.log");
  await writeFile(file, "own");
  await writeFile(other, "other chat");
  return { root, own, sibling, file, other, grants: [own] };
}

function acpRequest(kind: string, paths: unknown[]): RequestPermissionRequest {
  return {
    sessionId: "session",
    options: [],
    toolCall: { toolCallId: "tool", kind, locations: paths.map((path) => ({ path })) },
  } as unknown as RequestPermissionRequest;
}

describe("own attachment read grant", () => {
  it("allows only files inside this conversation's attachment directories", async () => {
    const { root, own, sibling, file, other, grants } = await store();
    expect(isOwnAttachmentPath(file, grants)).toBe(true);
    expect(isOwnAttachmentPath(own, grants)).toBe(true);
    expect(isOwnAttachmentPath(other, grants)).toBe(false);
    expect(isOwnAttachmentPath(sibling, grants)).toBe(false);
    expect(isOwnAttachmentPath(root, grants)).toBe(false);
    expect(isOwnAttachmentPath(join(own, "..", "22222222-2222-4222-8222-222222222222", "22222222-2222-4222-8222-222222222222.log"), grants)).toBe(false);
    expect(isOwnAttachmentPath(join(own, "missing.log"), grants)).toBe(false);
    expect(isOwnAttachmentPath(file, undefined)).toBe(false);
    expect(isOwnAttachmentPath(file, [])).toBe(false);
    for (const malformed of [undefined, null, 7, "", "relative/file.log", `${file}\0`, { path: file }]) {
      expect(isOwnAttachmentPath(malformed, grants)).toBe(false);
    }
  });

  it.skipIf(process.platform === "win32")("refuses a symbolic link inside an own attachment directory", async () => {
    const { own, other, grants } = await store();
    const link = join(own, "link.log");
    await symlink(other, link);
    expect(isOwnAttachmentPath(link, grants)).toBe(false);
    const linkedRoot = join(own, "..", "linked-root");
    await symlink(own, linkedRoot);
    expect(isOwnAttachmentPath(join(linkedRoot, "11111111-1111-4111-8111-111111111111.log"), grants)).toBe(false);
    expect(isOwnAttachmentPath(join(own, "11111111-1111-4111-8111-111111111111.log"), [linkedRoot])).toBe(false);
  });

  it("allows only Claude read tools whose every target is an own attachment", async () => {
    const { own, file, other, grants } = await store();
    expect(claudeAttachmentReadAllowed("Read", { file_path: file }, file, grants)).toBe(true);
    expect(claudeAttachmentReadAllowed("Grep", { path: own, pattern: "ERROR" }, own, grants)).toBe(true);
    expect(claudeAttachmentReadAllowed("Glob", { path: own, pattern: "*.log" }, undefined, grants)).toBe(true);
    expect(claudeAttachmentReadAllowed("Read", { file_path: other }, other, grants)).toBe(false);
    expect(claudeAttachmentReadAllowed("Read", { file_path: file }, other, grants)).toBe(false);
    expect(claudeAttachmentReadAllowed("Glob", { path: own, pattern: "../*/*.log" }, undefined, grants)).toBe(false);
    expect(claudeAttachmentReadAllowed("Grep", { path: own, glob: "/etc/*" }, undefined, grants)).toBe(false);
    expect(claudeAttachmentReadAllowed("Grep", { pattern: "ERROR" }, undefined, grants)).toBe(false);
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
      expect(claudeAttachmentReadAllowed(tool, { file_path: file, path: file, command: `cat ${file}` }, file, grants)).toBe(false);
    }
    expect(claudeAttachmentReadAllowed("Read", { file_path: file }, file, undefined)).toBe(false);
    expect(claudePermissionAccess("Read")).toBe("read");
    expect(claudePermissionAccess("Write")).toBe("write");
    expect(claudePermissionAccess("constructor")).toBe("write");
  });

  it("allows only ACP read requests whose every location is an own attachment", async () => {
    const { file, other, grants } = await store();
    expect(acpAttachmentReadAllowed(acpRequest("read", [file]), grants)).toBe(true);
    expect(acpAttachmentReadAllowed(acpRequest("read", [file, other]), grants)).toBe(false);
    expect(acpAttachmentReadAllowed(acpRequest("read", []), grants)).toBe(false);
    expect(acpAttachmentReadAllowed(acpRequest("read", [42]), grants)).toBe(false);
    for (const kind of ["edit", "delete", "move", "execute", "search", "other"]) {
      expect(acpAttachmentReadAllowed(acpRequest(kind, [file]), grants)).toBe(false);
    }
    expect(acpAttachmentReadAllowed({ sessionId: "session", options: [], toolCall: { toolCallId: "tool", kind: "read" } } as unknown as RequestPermissionRequest, grants)).toBe(false);
  });

  it("allows only OpenCode read permissions for own attachments", async () => {
    const { own, file, other, grants } = await store();
    expect(openCodeAttachmentReadAllowed("read", { patterns: [file] }, grants)).toBe(true);
    expect(openCodeAttachmentReadAllowed("read", { resources: [file] }, grants)).toBe(true);
    expect(openCodeAttachmentReadAllowed("read", { patterns: [file, other] }, grants)).toBe(false);
    expect(openCodeAttachmentReadAllowed("read", { patterns: [] }, grants)).toBe(false);
    expect(openCodeAttachmentReadAllowed("read", {}, grants)).toBe(false);
    for (const permission of ["edit", "external_directory", "bash", "*"]) {
      expect(openCodeAttachmentReadAllowed(permission, { patterns: [file, `${own}/*`] }, grants)).toBe(false);
    }
  });
});
