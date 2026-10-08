import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getUnifiedDiff,
  inspectDiffSelection,
  revertDiffSelection,
  undoDiffSelection,
} from "../../src/server/git";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const secureFiles = new SecureFileTestBroker();
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const LF = "alpha\nbeta\ngamma\n";
const CRLF = "alpha\r\nbeta\r\ngamma\r\n";
const EDITED = "alpha\r\ngamma\r\n";

function repository(autocrlf: "true" | "false", attributes?: string, seed = autocrlf === "true" ? CRLF : LF): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-autocrlf-reversal-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "core.autocrlf", autocrlf);
  git(root, "config", "user.name", "Inertia Test");
  git(root, "config", "user.email", "test@inertia.local");
  if (attributes !== undefined) writeFileSync(join(root, ".gitattributes"), attributes);
  writeFileSync(join(root, "example.txt"), seed);
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  expect(git(root, "show", "HEAD:example.txt")).toBe(LF);
  writeFileSync(join(root, "example.txt"), EDITED);
  return root;
}

async function revert(root: string, choose: (line: { kind: string; content: string }) => boolean) {
  const diff = await getUnifiedDiff(root, {}, undefined, secureFiles);
  const structured = parseUnifiedDiff(diff.text);
  const file = structured.files.find((candidate) => candidate.path === "example.txt")!;
  const hunk = file.hunks[0]!;
  const selected = hunk.lines.filter((line) => line.kind !== "context" && choose(line));
  expect(selected.length).toBeGreaterThan(0);
  const selection = {
    fingerprint: structured.fingerprint,
    filePath: file.path,
    hunkId: hunk.id,
    lineIds: selected.map(({ id }) => id),
  };
  const plan = await inspectDiffSelection(root, selection, secureFiles);
  return revertDiffSelection(root, { ...selection, expected: plan.validation }, secureFiles);
}

describe("selective reversal and line endings", () => {
  it("restores a deleted line with the working tree's CRLF ending under core.autocrlf", async () => {
    const root = repository("true");
    const result = await revert(root, (line) => line.kind === "deletion" && line.content === "beta");
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe(CRLF);
    await undoDiffSelection(root, result.operation.id, secureFiles);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe(EDITED);
  });

  it("restores a deleted line with CRLF when a text attribute normalizes the file", async () => {
    const root = repository("false", "*.txt text\n");
    await revert(root, (line) => line.kind === "deletion");
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe(CRLF);
  });

  it("restores HEAD's own bytes when Git treats the CRLF endings as content", async () => {
    const root = repository("false");
    await revert(root, () => true);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe(LF);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("restores HEAD's own bytes for a file marked -text even under core.autocrlf", async () => {
    const root = repository("true", "*.txt -text\n", LF);
    await revert(root, () => true);
    expect(readFileSync(join(root, "example.txt"), "utf8")).toBe(LF);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
