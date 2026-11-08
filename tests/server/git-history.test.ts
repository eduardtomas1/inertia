import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { blameGitFile, parseBlamePorcelain } from "../../src/server/git/blame";
import { parseCommitFiles, showGitCommit } from "../../src/server/git/commit-show";
import {
  decodeLogCursor,
  encodeLogCursor,
  GIT_HISTORY_TIMEOUT_MS,
  readGitLog,
  type GitHistoryRunner,
} from "../../src/server/git/log";
import { runGitInspection } from "../../src/server/git/runner";
import { GitError } from "../../src/server/git/types";
import { handleGitHistoryCommand } from "../../src/server/runtime/commands/git-history-commands";
import { clientCommandSchema, type ServerEvent } from "../../src/shared/contracts";
import {
  GIT_COMMIT_SHA_PATTERN,
  gitBlamePageSchema,
  gitCommitDetailSchema,
  gitLogPageSchema,
} from "../../src/shared/contracts/git-history";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05Z",
      GIT_COMMITTER_DATE: "2026-01-02T03:04:05Z",
    },
  }).trim();
}

function repository(name = "repo"): { base: string; root: string } {
  const base = mkdtempSync(join(tmpdir(), "inertia-git-history-"));
  roots.push(base);
  const root = join(base, name);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "History Author");
  git(root, "config", "user.email", "secret-author@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  return { base, root };
}

function commit(root: string, path: string, content: string, message: string): string {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
  git(root, "add", "--", path);
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

describe("git.log", () => {
  it("pages through the current branch with an opaque, anchored cursor", async () => {
    const { root } = repository();
    const shas = Array.from({ length: 7 }, (_, index) =>
      commit(root, "file.txt", `${index}\n`, `Commit ${index}`));
    const first = await readGitLog(root, { limit: 3 });
    expect(gitLogPageSchema.parse(first)).toEqual(first);
    expect(first.head).toBe(shas[6]);
    expect(first.commits.map(({ subject }) => subject)).toEqual(["Commit 6", "Commit 5", "Commit 4"]);
    expect(first.commits[0]).toMatchObject({
      sha: shas[6],
      authorName: "History Author",
      parents: [shas[5]],
      isMerge: false,
    });
    expect(JSON.stringify(first)).not.toContain("secret-author");
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);

    // A new commit on the branch does not shift the anchored pages.
    commit(root, "file.txt", "moved\n", "Later commit");
    const second = await readGitLog(root, { limit: 3, cursor: first.nextCursor! });
    expect(second.commits.map(({ subject }) => subject)).toEqual(["Commit 3", "Commit 2", "Commit 1"]);
    const third = await readGitLog(root, { limit: 3, cursor: second.nextCursor! });
    expect(third.commits.map(({ subject }) => subject)).toEqual(["Commit 0"]);
    expect(third.nextCursor).toBeNull();
  });

  it("rejects malformed cursors and out-of-range limits", async () => {
    const { root } = repository();
    commit(root, "a.txt", "a\n", "Only");
    await expect(readGitLog(root, { cursor: "not a cursor" })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(readGitLog(root, { cursor: Buffer.from("v1:x:1:y").toString("base64url") }))
      .rejects.toMatchObject({ code: "invalid-input" });
    await expect(readGitLog(root, { limit: 101 })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(readGitLog(root, { limit: 0 })).rejects.toMatchObject({ code: "invalid-input" });
    const cursor = { head: "a".repeat(40), skip: 4, last: "b".repeat(40) };
    expect(decodeLogCursor(encodeLogCursor(cursor))).toEqual(cursor);
  });

  it("reports a rewritten history instead of skipping commits", async () => {
    const { root } = repository();
    for (let index = 0; index < 4; index += 1) commit(root, "a.txt", `${index}\n`, `C${index}`);
    const first = await readGitLog(root, { limit: 2 });
    const forged = encodeLogCursor({ head: first.head!, skip: 2, last: "f".repeat(40) });
    await expect(readGitLog(root, { limit: 2, cursor: forged })).rejects.toMatchObject({ code: "conflict" });
  });

  it("limits history to one path and flags merge commits", async () => {
    const { root } = repository();
    commit(root, "tracked/a.txt", "a\n", "Add a");
    commit(root, "other.txt", "o\n", "Add other");
    git(root, "checkout", "-q", "-b", "feature");
    commit(root, "tracked/a.txt", "a2\n", "Change a on feature");
    git(root, "checkout", "-q", "main");
    commit(root, "other.txt", "o2\n", "Change other on main");
    git(root, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature");

    const page = await readGitLog(root, {});
    const merge = page.commits.find(({ subject }) => subject === "Merge feature");
    expect(merge).toMatchObject({ isMerge: true });
    expect(merge?.parents).toHaveLength(2);
    expect(page.commits.filter(({ isMerge }) => isMerge)).toHaveLength(1);

    const pathPage = await readGitLog(root, { path: "tracked/a.txt" });
    expect(pathPage.path).toBe("tracked/a.txt");
    expect(pathPage.commits.map(({ subject }) => subject)).toEqual(["Change a on feature", "Add a"]);
  });

  it("returns an empty page for an unborn branch and refuses paths outside the repository", async () => {
    const { base, root } = repository();
    expect(await readGitLog(root, {})).toEqual({ head: null, path: null, commits: [], nextCursor: null });
    commit(root, "a.txt", "a\n", "A");
    await expect(readGitLog(root, { path: "../outside" })).rejects.toMatchObject({ code: "invalid-input" });
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(root, "escape"), "dir");
    await expect(readGitLog(root, { path: "escape/file.txt" })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("scopes a nested repository's history to that repository", async () => {
    const { root } = repository();
    commit(root, "parent.txt", "p\n", "Parent commit");
    const nested = join(root, "vendor", "nested");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-q", "-b", "main");
    git(nested, "config", "user.name", "Nested Author");
    git(nested, "config", "user.email", "nested@example.invalid");
    commit(nested, "n.txt", "n\n", "Nested commit");
    const parent = await readGitLog(root, {});
    const child = await readGitLog(nested, {});
    expect(parent.commits.map(({ subject }) => subject)).toEqual(["Parent commit"]);
    expect(child.commits.map(({ subject }) => subject)).toEqual(["Nested commit"]);
  });

  it("reports a forged cursor whose anchor commit is not in the repository as changed history", async () => {
    const { root } = repository();
    for (let index = 0; index < 3; index += 1) commit(root, "a.txt", `${index}\n`, `C${index}`);
    const first = await readGitLog(root, { limit: 1 });
    const forged = encodeLogCursor({ head: "e".repeat(40), skip: 1, last: first.commits[0]!.sha });
    await expect(readGitLog(root, { limit: 1, cursor: forged })).rejects.toMatchObject({
      code: "conflict",
      message: "The history changed while it was being read. Reload the history.",
    });
  });

  it("reports the output limit when a later page is cut off inside its first record", async () => {
    const { root } = repository();
    for (let index = 0; index < 3; index += 1) commit(root, "a.txt", `${index}\n`, `C${index}`);
    const first = await readGitLog(root, { limit: 1 });
    const runner: GitHistoryRunner = async (cwd, args, options) => {
      if (args[0] !== "log") return await runGitInspection(cwd, args, options);
      const complete = await runGitInspection(cwd, args, options);
      return { ...complete, stdout: complete.stdout.subarray(0, 30), truncated: true };
    };
    await expect(readGitLog(root, { limit: 1, cursor: first.nextCursor!, runner })).rejects.toMatchObject({
      code: "output-limit",
    });
  });

  it("uses a 5 second bounded inspection and surfaces runner timeouts", async () => {
    const { root } = repository();
    commit(root, "a.txt", "a\n", "A");
    const calls: Array<{ args: readonly string[]; timeoutMs?: number; maxOutputBytes?: number; truncateOutput?: boolean }> = [];
    const runner: GitHistoryRunner = async (cwd, args, options) => {
      calls.push({ args, ...options });
      if (args[0] === "log") throw new GitError("timeout", "Git took too long to complete the operation.");
      return await runGitInspection(cwd, args, options);
    };
    await expect(readGitLog(root, { runner })).rejects.toMatchObject({ code: "timeout" });
    expect(calls.map(({ timeoutMs }) => timeoutMs)).toEqual([GIT_HISTORY_TIMEOUT_MS, GIT_HISTORY_TIMEOUT_MS]);
    const log = calls.find(({ args }) => args[0] === "log");
    expect(log).toMatchObject({ truncateOutput: true, maxOutputBytes: 2 * 1024 * 1024 });
    expect(log?.args).toEqual(expect.arrayContaining(["-z", "--no-show-signature", "--max-count=51", "--"]));
    expect(log?.args.some((arg) => arg.includes("%ae") || arg.includes("%aE"))).toBe(false);
  });
});

describe("git.commit.show", () => {
  it("shows a root commit, its files and its diff", async () => {
    const { root } = repository();
    writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    git(root, "add", "bin.dat");
    const sha = commit(root, "readme.md", "hello\nworld\n", "Initial commit\n\nLonger body text.");
    const detail = await showGitCommit(root, { sha: sha.slice(0, 10) });
    expect(gitCommitDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({
      sha,
      subject: "Initial commit",
      body: "Longer body text.",
      bodyTruncated: false,
      parents: [],
      isMerge: false,
      filesTruncated: false,
      diffTruncated: false,
    });
    expect(detail.files).toEqual([
      { path: "bin.dat", previousPath: null, status: "added", additions: null, deletions: null },
      { path: "readme.md", previousPath: null, status: "added", additions: 2, deletions: 0 },
    ]);
    expect(detail.diff).toContain("+++ b/readme.md");
    expect(detail.diff).toContain("+hello");
    expect(JSON.stringify(detail)).not.toContain("secret-author");
  });

  it("diffs a merge against its first parent and reports renames", async () => {
    const { root } = repository();
    commit(root, "big.txt", `${Array.from({ length: 40 }, (_, index) => index).join("\n")}\n`, "Add big");
    git(root, "mv", "big.txt", "moved.txt");
    writeFileSync(join(root, "moved.txt"), `${Array.from({ length: 41 }, (_, index) => index).join("\n")}\n`);
    git(root, "commit", "-q", "-am", "Rename big");
    const renamed = await showGitCommit(root, { sha: git(root, "rev-parse", "HEAD") });
    expect(renamed.files).toEqual([
      { path: "moved.txt", previousPath: "big.txt", status: "renamed", additions: 1, deletions: 0 },
    ]);
    git(root, "checkout", "-q", "-b", "side");
    commit(root, "side.txt", "s\n", "Side");
    git(root, "checkout", "-q", "main");
    commit(root, "main.txt", "m\n", "Main");
    git(root, "merge", "-q", "--no-ff", "-m", "Merge side", "side");
    const merge = await showGitCommit(root, { sha: git(root, "rev-parse", "HEAD") });
    expect(merge.isMerge).toBe(true);
    expect(merge.files.map(({ path }) => path)).toEqual(["side.txt"]);
  });

  it("bounds the diff and the body and validates the commit identifier", async () => {
    const { root } = repository();
    const sha = commit(root, "large.txt", `${"x".repeat(200)}\n`.repeat(2_000), `Large\n\n${"b".repeat(9_000)}`);
    const detail = await showGitCommit(root, { sha });
    expect(detail.diffTruncated).toBe(true);
    expect(Buffer.byteLength(detail.diff)).toBeLessThanOrEqual(256 * 1024);
    expect(detail.bodyTruncated).toBe(true);
    expect(detail.body.length).toBeLessThanOrEqual(8 * 1024);
    for (const invalid of ["HEAD", "--output=/tmp/x", "abc", "ABCDEF1", `${sha}x`, "a".repeat(65)]) {
      await expect(showGitCommit(root, { sha: invalid })).rejects.toMatchObject({ code: "invalid-input" });
    }
    // Longer than a SHA-1 name, so only an abbreviated SHA-256 name could match.
    await expect(showGitCommit(root, { sha: `${sha}0` })).rejects.toMatchObject({ code: "not-found" });
    await expect(showGitCommit(root, { sha: "deadbee" })).rejects.toMatchObject({ code: "not-found" });
  });

  it("resolves an abbreviation to its commit even when a branch has the same name", async () => {
    const { root } = repository();
    const first = commit(root, "a.txt", "a\n", "First");
    commit(root, "a.txt", "b\n", "Second");
    git(root, "branch", first.slice(0, 7), "HEAD");
    const detail = await showGitCommit(root, { sha: first.slice(0, 7) });
    expect(detail).toMatchObject({ sha: first, subject: "First" });
  });

  it("refuses a tag object and reports an abbreviation shared by several commits", async () => {
    const { root } = repository();
    const sha = commit(root, "a.txt", "a\n", "Tagged");
    git(root, "tag", "-a", "-m", "Release", "v1");
    const tag = git(root, "rev-parse", "v1");
    await expect(showGitCommit(root, { sha: tag })).rejects.toMatchObject({ code: "not-found" });

    const other = `${sha.slice(0, 7)}${sha[7] === "0" ? "1" : "0"}`.padEnd(40, "1");
    const runner: GitHistoryRunner = async (cwd, args, options) => {
      if (args[0] === "rev-parse" && args[1]?.startsWith("--disambiguate=")) {
        return { stdout: Buffer.from(`${sha}\n${other}\n`), stderr: Buffer.alloc(0), truncated: false };
      }
      if (args[0] === "cat-file") {
        return { stdout: Buffer.from("commit\n"), stderr: Buffer.alloc(0), truncated: false };
      }
      return await runGitInspection(cwd, args, options);
    };
    await expect(showGitCommit(root, { sha: sha.slice(0, 7), runner })).rejects.toMatchObject({
      code: "conflict",
      message: "That short commit identifier matches more than one commit. Use the full identifier.",
    });
  });

  it("shows commits of a SHA-256 repository by full and abbreviated id", async () => {
    const base = mkdtempSync(join(tmpdir(), "inertia-git-history-sha256-"));
    roots.push(base);
    const root = join(base, "repo");
    mkdirSync(root);
    git(root, "init", "-q", "-b", "main", "--object-format=sha256");
    git(root, "config", "user.name", "History Author");
    git(root, "config", "user.email", "secret-author@example.invalid");
    const sha = commit(root, "a.txt", "a\n", "Wide id");
    expect(sha).toMatch(/^[0-9a-f]{64}$/u);
    expect(GIT_COMMIT_SHA_PATTERN.test(sha)).toBe(true);
    expect(clientCommandSchema.safeParse({
      type: "git.commit.show",
      requestId: crypto.randomUUID(),
      payload: { projectId: crypto.randomUUID(), sha },
    }).success).toBe(true);

    const page = await readGitLog(root, {});
    expect(page.commits[0]?.sha).toBe(sha);
    for (const id of [sha, sha.slice(0, 12)]) {
      const detail = await showGitCommit(root, { sha: id });
      expect(gitCommitDetailSchema.parse(detail)).toEqual(detail);
      expect(detail).toMatchObject({ sha, subject: "Wide id" });
    }
    expect(GIT_COMMIT_SHA_PATTERN.test(`${sha}0`)).toBe(false);
  });

  it("parses raw and numstat records positionally, including colon-prefixed paths", () => {
    const header = (status: string) => `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} ${status}`;
    const output = Buffer.from([
      header("M"), ":odd", header("R087"), "old", "new", header("D"), "gone",
      "1\t2\t:odd", "3\t4\t", "old", "new", "0\t5\tgone", "",
    ].join("\0"));
    expect(parseCommitFiles(output)).toEqual({
      truncated: false,
      files: [
        { path: ":odd", previousPath: null, status: "modified", additions: 1, deletions: 2 },
        { path: "new", previousPath: "old", status: "renamed", additions: 3, deletions: 4 },
        { path: "gone", previousPath: null, status: "deleted", additions: 0, deletions: 5 },
      ],
    });
    expect(parseCommitFiles(output, 2)).toMatchObject({ truncated: true, files: [{ path: ":odd" }, { path: "new" }] });
  });
});

describe("git.blame", () => {
  it("blames line ranges of tracked files and marks uncommitted lines", async () => {
    const { root } = repository();
    const first = commit(root, "src/a.txt", "one\ntwo\nthree\n", "First");
    const second = commit(root, "src/a.txt", "one\nTWO\nthree\nfour\n", "Second");
    writeFileSync(join(root, "src/a.txt"), "one\nTWO\nthree\nfour\nfive");
    const page = await blameGitFile(root, { path: "src/a.txt", startLine: 2, endLine: 5 });
    expect(gitBlamePageSchema.parse(page)).toEqual(page);
    expect(page).toMatchObject({ state: "ready", startLine: 2, endLine: 5, lineCount: 5, nextStartLine: null });
    expect(page.lines.map(({ line, sha, uncommitted }) => [line, sha, uncommitted])).toEqual([
      [2, second, false],
      [3, first, false],
      [4, second, false],
      [5, "0".repeat(40), true],
    ]);
    expect(page.lines[0]).toMatchObject({ authorName: "History Author", summary: "Second", shortSha: second.slice(0, 7) });
    expect(JSON.stringify(page)).not.toContain("secret-author");

    const paged = await blameGitFile(root, { path: "src/a.txt", startLine: 1, endLine: 2 });
    expect(paged).toMatchObject({ endLine: 2, nextStartLine: 3 });
    expect(await blameGitFile(root, { path: "src/a.txt", startLine: 9 }))
      .toMatchObject({ state: "ready", lines: [], lineCount: 5, nextStartLine: null });
  });

  it("pages large files in 2,000-line windows", async () => {
    const { root } = repository();
    commit(root, "long.txt", Array.from({ length: 2_500 }, (_, index) => `line ${index}`).join("\n"), "Long");
    const first = await blameGitFile(root, { path: "long.txt" });
    expect(first).toMatchObject({ startLine: 1, endLine: 2_000, lineCount: 2_500, nextStartLine: 2_001 });
    expect(first.lines).toHaveLength(2_000);
    const second = await blameGitFile(root, { path: "long.txt", startLine: 2_001, endLine: 9_000 });
    expect(second).toMatchObject({ endLine: 2_500, nextStartLine: null });
    expect(second.lines).toHaveLength(500);
  });

  it("returns empty results for untracked, binary and symlinked entries", async () => {
    const { base, root } = repository();
    commit(root, "kept.txt", "k\n", "Kept");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    expect(await blameGitFile(root, { path: "new.txt" })).toMatchObject({ state: "untracked", lines: [] });
    writeFileSync(join(root, "image.bin"), Buffer.from([1, 0, 2, 0]));
    git(root, "add", "image.bin");
    git(root, "commit", "-q", "-m", "Binary");
    expect(await blameGitFile(root, { path: "image.bin" })).toMatchObject({ state: "binary", lines: [] });
    symlinkSync("kept.txt", join(root, "link.txt"));
    git(root, "add", "link.txt");
    git(root, "commit", "-q", "-m", "Link");
    expect(await blameGitFile(root, { path: "link.txt" })).toMatchObject({ state: "unsupported", lines: [] });

    writeFileSync(join(base, "secret.txt"), "outside\n");
    symlinkSync(join(base, "secret.txt"), join(root, "escape.txt"));
    await expect(blameGitFile(root, { path: "escape.txt" })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(blameGitFile(root, { path: "../secret.txt" })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(blameGitFile(root, { path: "missing.txt" })).rejects.toMatchObject({ code: "not-found" });
    await expect(blameGitFile(root, { path: "kept.txt", startLine: 3, endLine: 2 })).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("ends the page where the clean-filtered content ends instead of failing on Git's range check", async () => {
    const { root } = repository();
    // A clean filter stores a short pointer, as Git LFS does, while the file
    // on disk keeps all of its lines.
    git(root, "config", "filter.pointer.clean", "head -n 3");
    git(root, "config", "filter.pointer.smudge", "cat");
    writeFileSync(join(root, ".gitattributes"), "big.txt filter=pointer\n");
    commit(root, "big.txt", Array.from({ length: 2_500 }, (_, index) => `line ${index}\n`).join(""), "Pointer");

    const first = await blameGitFile(root, { path: "big.txt" });
    expect(gitBlamePageSchema.parse(first)).toEqual(first);
    expect(first).toMatchObject({ state: "ready", startLine: 1, endLine: 3, lineCount: 3, nextStartLine: null });
    expect(first.lines.map(({ line }) => line)).toEqual([1, 2, 3]);

    const beyond = await blameGitFile(root, { path: "big.txt", startLine: 2_001 });
    expect(gitBlamePageSchema.parse(beyond)).toEqual(beyond);
    expect(beyond).toMatchObject({ state: "ready", lines: [], nextStartLine: null });
  });

  it("still reports a blame failure that is not a range error", async () => {
    const { root } = repository();
    commit(root, "a.txt", "one\ntwo\nthree\n", "A");
    const runner: GitHistoryRunner = async (cwd, args, options) => {
      if (args[0] === "blame") {
        throw new GitError("operation-failed", "Unable to read blame for this file.", 128);
      }
      return await runGitInspection(cwd, args, options);
    };
    await expect(blameGitFile(root, { path: "a.txt", startLine: 2, runner }))
      .rejects.toMatchObject({ code: "operation-failed", message: "Unable to read blame for this file." });
  });

  it("drops a truncated porcelain entry", () => {
    const sha = "c".repeat(40);
    const complete = `${sha} 1 1 2\nauthor A\nauthor-mail <a@example.invalid>\nauthor-time 100\nsummary S\nfilename f\n\tone\n`;
    const lines = parseBlamePorcelain(Buffer.from(`${complete}${sha} 2 2\n\ttw`));
    expect(lines).toEqual([{
      line: 1, sha, shortSha: sha.slice(0, 7), authorName: "A", authorDate: new Date(100_000).toISOString(),
      summary: "S", uncommitted: false,
    }]);
  });
});

describe("git history command handler", () => {
  function socket(): WebSocket {
    return new EventEmitter() as unknown as WebSocket;
  }

  it("resolves the requested scope, runs verified and returns the typed result", async () => {
    const { root } = repository();
    commit(root, "a.txt", "a\n", "Handled");
    const send = vi.fn<(socket: WebSocket, event: ServerEvent) => void>();
    const resolveRepository = vi.fn(async () => ({ root }));
    const verified = vi.fn();
    const runVerified = async <Result,>(
      repository: { root: string },
      operation: (root: string) => Promise<Result>,
    ): Promise<Result> => {
      verified(repository.root);
      return await operation(repository.root);
    };
    const payload = {
      projectId: crypto.randomUUID(),
      repositoryPath: "vendor/nested",
      authorityRef: crypto.randomUUID(),
      limit: 5,
    };
    await handleGitHistoryCommand({
      socket: socket(),
      command: { type: "git.log", requestId: "request-1", payload },
      resolveRepository,
      runVerified,
      send,
    });
    expect(resolveRepository).toHaveBeenCalledWith(expect.anything(), payload, expect.objectContaining({
      deadlineAt: expect.any(Number),
      signal: expect.any(AbortSignal),
    }));
    expect(verified).toHaveBeenCalledExactlyOnceWith(root);
    const event = send.mock.calls[0]?.[1];
    expect(event).toMatchObject({ type: "request.result", requestId: "request-1", result: { kind: "git.log" } });
    if (event?.type === "request.result" && event.result.kind === "git.log") {
      expect(event.result.page.commits.map(({ subject }) => subject)).toEqual(["Handled"]);
    }
  });

  it("propagates scope failures without sending a result", async () => {
    const send = vi.fn();
    await expect(handleGitHistoryCommand({
      socket: socket(),
      command: {
        type: "git.blame",
        requestId: "request-2",
        payload: { projectId: crypto.randomUUID(), path: "a.txt" },
      },
      resolveRepository: async () => { throw new GitError("not-repository", "The selected folder is not a Git repository."); },
      runVerified: vi.fn(),
      send,
    })).rejects.toThrow("not a Git repository");
    expect(send).not.toHaveBeenCalled();
  });
});
