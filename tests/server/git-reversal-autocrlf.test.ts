import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

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

it("restores a deleted line with the working tree's CRLF ending under core.autocrlf", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-autocrlf-reversal-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "core.autocrlf", "true");
  git(root, "config", "user.name", "Inertia Test");
  git(root, "config", "user.email", "test@inertia.local");
  const original = "alpha\r\nbeta\r\ngamma\r\n";
  writeFileSync(join(root, "example.txt"), original);
  git(root, "add", "example.txt");
  git(root, "commit", "-m", "base");
  expect(git(root, "show", "HEAD:example.txt")).toBe("alpha\nbeta\ngamma\n");

  const edited = "alpha\r\ngamma\r\n";
  writeFileSync(join(root, "example.txt"), edited);
  const diff = await getUnifiedDiff(root, {}, undefined, secureFiles);
  const structured = parseUnifiedDiff(diff.text);
  const file = structured.files[0]!;
  const hunk = file.hunks[0]!;
  const selected = hunk.lines.filter((line) => line.kind === "deletion" && line.content === "beta");
  expect(selected).toHaveLength(1);
  const selection = {
    fingerprint: structured.fingerprint,
    filePath: file.path,
    hunkId: hunk.id,
    lineIds: selected.map(({ id }) => id),
  };
  const plan = await inspectDiffSelection(root, selection, secureFiles);
  const result = await revertDiffSelection(root, { ...selection, expected: plan.validation }, secureFiles);

  expect(readFileSync(join(root, "example.txt"), "utf8")).toBe(original);
  await undoDiffSelection(root, result.operation.id, secureFiles);
  expect(readFileSync(join(root, "example.txt"), "utf8")).toBe(edited);
});
