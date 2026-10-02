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
  type GitDiffSelection,
} from "../../src/server/git";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const secureFiles = new SecureFileTestBroker();
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function repository(content: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-bom-reversal-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "user.name", "Inertia Test");
  git(root, "config", "user.email", "test@inertia.local");
  writeFileSync(join(root, "example.txt"), content);
  git(root, "add", "example.txt");
  git(root, "commit", "-m", "base");
  return root;
}

type Line = ReturnType<typeof parseUnifiedDiff>["files"][number]["hunks"][number]["lines"][number];

async function selectionFor(root: string, predicate: (line: Line) => boolean): Promise<GitDiffSelection> {
  const diff = await getUnifiedDiff(root, {}, undefined, secureFiles);
  const structured = parseUnifiedDiff(diff.text);
  const file = structured.files[0]!;
  const hunk = file.hunks.find((candidate) => candidate.lines.some(predicate))!;
  const selected = hunk.lines.filter(predicate);
  expect(selected.length).toBeGreaterThan(0);
  return { fingerprint: structured.fingerprint, filePath: file.path, hunkId: hunk.id, lineIds: selected.map(({ id }) => id) };
}

async function apply(root: string, selection: GitDiffSelection) {
  const plan = await inspectDiffSelection(root, selection, secureFiles);
  return revertDiffSelection(root, { ...selection, expected: plan.validation }, secureFiles);
}

const many = (prefix: string, count: number, ending: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}${ending}`).join("");

describe("UTF-8 BOM selective reversal in real repositories", () => {
  it("reverts only the selected far hunk in a BOM+CRLF file and undoes exactly", async () => {
    const original = Buffer.from(`﻿head\r\n${many("line", 30, "\r\n")}tail\r\n`);
    const edited = Buffer.from(`﻿HEAD\r\n${many("line", 30, "\r\n")}tail\r\nadded\r\n`);
    const root = repository(original);
    writeFileSync(join(root, "example.txt"), edited);
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "added");
    const result = await apply(root, selection);
    expect(readFileSync(join(root, "example.txt"))).toEqual(
      Buffer.from(`﻿HEAD\r\n${many("line", 30, "\r\n")}tail\r\n`),
    );
    await undoDiffSelection(root, result.operation.id, secureFiles);
    expect(readFileSync(join(root, "example.txt"))).toEqual(edited);
  });

  it("reverts a selected first-line edit in a BOM+CRLF file leaving the other hunk", async () => {
    const original = Buffer.from(`﻿head\r\n${many("line", 30, "\r\n")}tail\r\n`);
    const edited = Buffer.from(`﻿HEAD\r\n${many("line", 30, "\r\n")}tail\r\nadded\r\n`);
    const root = repository(original);
    writeFileSync(join(root, "example.txt"), edited);
    const selection = await selectionFor(root, (line) =>
      (line.kind === "addition" && line.content === "﻿HEAD")
      || (line.kind === "deletion" && line.content === "﻿head"));
    await apply(root, selection);
    expect(readFileSync(join(root, "example.txt"))).toEqual(
      Buffer.from(`﻿head\r\n${many("line", 30, "\r\n")}tail\r\nadded\r\n`),
    );
  });

  it("restores a removed BOM when its first-line change is selected", async () => {
    const original = Buffer.from(`﻿head\n${many("line", 30, "\n")}`);
    const edited = Buffer.from(`head\n${many("line", 30, "\n")}added\n`);
    const root = repository(original);
    writeFileSync(join(root, "example.txt"), edited);
    const selection = await selectionFor(root, (line) =>
      (line.kind === "addition" && line.content === "head")
      || (line.kind === "deletion" && line.content === "﻿head"));
    await apply(root, selection);
    expect(readFileSync(join(root, "example.txt"))).toEqual(
      Buffer.from(`﻿head\n${many("line", 30, "\n")}added\n`),
    );
  });

  it("keeps a mid-file U+FEFF and an unselected BOM intact", async () => {
    const original = Buffer.from("﻿alpha\nbe﻿ta\n");
    const edited = Buffer.from("﻿alpha\nbe﻿ta\n﻿gamma\n");
    const root = repository(original);
    writeFileSync(join(root, "example.txt"), edited);
    const selection = await selectionFor(root, (line) => line.kind === "addition" && line.content === "﻿gamma");
    await apply(root, selection);
    expect(readFileSync(join(root, "example.txt"))).toEqual(original);
  });
});
