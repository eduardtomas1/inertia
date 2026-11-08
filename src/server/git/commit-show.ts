import {
  GIT_COMMIT_SHA_PATTERN,
  GIT_HISTORY_LIMITS,
  type GitCommitDetail,
  type GitCommitFile,
  type GitCommitFileStatus,
} from "../../shared/contracts/git-history";
import {
  boundedText,
  canonicalHistoryRoot,
  completeNulFields,
  historyRunOptions,
  type GitHistoryOptions,
} from "./log";
import { runGitInspection, utf8Prefix } from "./runner";
import { GitError } from "./types";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHOW_FORMAT = ["%H", "%h", "%P", "%an", "%aI", "%s", "%b"].join("%x00");
const METADATA_OUTPUT_BYTES = 64 * 1024;
const FILE_LIST_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Objects sharing one abbreviation that are type-checked before giving up. */
const MAX_ABBREVIATION_CANDIDATES = 16;
const NOT_FOUND = "That commit could not be found in this repository.";
const AMBIGUOUS =
  "That short commit identifier matches more than one commit. Use the full identifier.";

const STATUS_CODES: Record<string, GitCommitFileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type-changed",
  U: "unmerged",
};

export interface GitCommitShowOptions extends GitHistoryOptions {
  sha: string;
}

/**
 * Parses `git diff-tree -r -z --raw --numstat` output. Raw entries come first
 * (one header token beginning with ":" followed by one path, or two for a
 * rename or copy), then one numstat entry per file in the same order. The
 * parse is positional, so a path that itself begins with ":" is not confused
 * with a header. Truncated output yields only complete entries.
 */
export function parseCommitFiles(
  output: Buffer,
  maximum: number = GIT_HISTORY_LIMITS.commitFiles,
): { files: GitCommitFile[]; truncated: boolean } {
  const tokens = completeNulFields(output);
  const files: GitCommitFile[] = [];
  let index = 0;
  let truncated = false;
  while (index < tokens.length && tokens[index]?.startsWith(":")) {
    const header = tokens[index] ?? "";
    const statusToken = header.split(" ").at(-1) ?? "";
    const code = statusToken.charAt(0);
    const paired = code === "R" || code === "C";
    const needed = paired ? 3 : 2;
    if (index + needed > tokens.length) {
      truncated = true;
      break;
    }
    const first = tokens[index + 1] ?? "";
    const second = paired ? tokens[index + 2] ?? "" : null;
    if (files.length < maximum) {
      files.push({
        path: second ?? first,
        previousPath: second === null ? null : first,
        status: STATUS_CODES[code] ?? "unknown",
        additions: null,
        deletions: null,
      });
    } else {
      truncated = true;
    }
    index += needed;
  }
  let fileIndex = 0;
  while (index < tokens.length && fileIndex < files.length) {
    const [additions = "", deletions = "", inlinePath = ""] = (tokens[index] ?? "").split("\t");
    index += inlinePath === "" ? 3 : 1;
    if (index > tokens.length) break;
    const file = files[fileIndex];
    if (file) {
      file.additions = /^\d+$/u.test(additions) ? Number(additions) : null;
      file.deletions = /^\d+$/u.test(deletions) ? Number(deletions) : null;
    }
    fileIndex += 1;
  }
  return { files, truncated };
}

function validateSha(sha: string): string {
  if (typeof sha !== "string" || !GIT_COMMIT_SHA_PATTERN.test(sha)) {
    throw new GitError("invalid-input", "The commit identifier is invalid.");
  }
  return sha;
}

/**
 * Resolves a commit id to the one object whose name starts with it. Git's own
 * revision lookup prefers a branch or tag of the same name over an
 * abbreviation, so object names are listed with `--disambiguate`, which never
 * consults refs, and only commit objects are accepted.
 */
async function resolveCommitId(
  root: string,
  sha: string,
  run: NonNullable<GitHistoryOptions["runner"]>,
  options: GitHistoryOptions,
): Promise<string> {
  const listed = await run(
    root,
    ["rev-parse", `--disambiguate=${sha}`],
    historyRunOptions(options, {
      maxOutputBytes: 64 * 1024,
      truncateOutput: true,
      failureMessage: NOT_FOUND,
    }),
  );
  const candidates = listed.stdout.toString("utf8").split("\n")
    .map((line) => line.trim())
    .filter((line) => FULL_SHA.test(line) && line.startsWith(sha));
  if (candidates.length === 0) {
    if (listed.truncated) throw new GitError("conflict", AMBIGUOUS);
    throw new GitError("not-found", NOT_FOUND);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (listed.truncated || candidates.length > MAX_ABBREVIATION_CANDIDATES) {
    throw new GitError("conflict", AMBIGUOUS);
  }
  const commits: string[] = [];
  for (const candidate of candidates) {
    const type = await run(
      root,
      ["cat-file", "-t", candidate],
      historyRunOptions(options, {
        maxOutputBytes: 64,
        failureMessage: NOT_FOUND,
      }),
    );
    if (type.stdout.toString("utf8").trim() === "commit") commits.push(candidate);
  }
  if (commits.length === 0) throw new GitError("not-found", NOT_FOUND);
  if (commits.length > 1) throw new GitError("conflict", AMBIGUOUS);
  return commits[0]!;
}

/**
 * Reads one commit's metadata, changed files and unified diff. Merge commits
 * are compared with their first parent and root commits with the empty tree
 * (`diff-tree --root`), so every commit has a deterministic single diff.
 */
export async function showGitCommit(
  root: string,
  options: GitCommitShowOptions,
): Promise<GitCommitDetail> {
  const requested = validateSha(options.sha);
  const run = options.runner ?? runGitInspection;
  const canonicalRoot = await canonicalHistoryRoot(root);
  const sha = await resolveCommitId(canonicalRoot, requested, run, options);
  const metadata = await run(
    canonicalRoot,
    [
      "show",
      "-s",
      "--no-color",
      "--no-show-signature",
      "--encoding=UTF-8",
      `--format=${SHOW_FORMAT}`,
      `${sha}^{commit}`,
      "--",
    ],
    historyRunOptions(options, {
      maxOutputBytes: METADATA_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: NOT_FOUND,
    }),
  ).catch((error: unknown) => {
    if (error instanceof GitError && error.code === "operation-failed" && error.exitCode === 128) {
      throw new GitError("not-found", NOT_FOUND);
    }
    throw error;
  });
  const text = metadata.stdout.toString("utf8");
  const fields = text.split("\0");
  if (fields.length < 7) {
    throw new GitError("operation-failed", "Git returned unreadable commit details.");
  }
  const [fullSha = "", shortSha = "", parentText = "", authorName = "", authorDate = "", subject = ""] = fields;
  const parents = parentText ? parentText.split(" ") : [];
  // A tag object peels to a commit with another name; only the commit
  // object the identifier names is shown.
  if (FULL_SHA.test(fullSha) && fullSha !== sha) {
    throw new GitError("not-found", NOT_FOUND);
  }
  if (
    !FULL_SHA.test(fullSha)
    || parents.some((parent) => !FULL_SHA.test(parent))
    || !Number.isFinite(Date.parse(authorDate))
  ) {
    throw new GitError("operation-failed", "Git returned unreadable commit details.");
  }
  const rawBody = fields.slice(6).join("\0").replace(/\n+$/u, "");
  const bodyBuffer = Buffer.from(rawBody, "utf8");
  const bodyTruncated = metadata.truncated
    || bodyBuffer.length > GIT_HISTORY_LIMITS.commitBodyBytes;
  const body = utf8Prefix(bodyBuffer, GIT_HISTORY_LIMITS.commitBodyBytes);

  const firstParent = parents[0];
  const comparison = firstParent ? [firstParent, fullSha] : ["--root", fullSha];
  const common = ["-r", "-M", "--no-commit-id", "--no-ext-diff", "--no-textconv"];
  const fileList = await run(
    canonicalRoot,
    ["diff-tree", ...common, "-z", "--raw", "--numstat", ...comparison, "--"],
    historyRunOptions(options, {
      maxOutputBytes: FILE_LIST_OUTPUT_BYTES,
      truncateOutput: true,
      failureMessage: "Unable to list the files changed by this commit.",
    }),
  );
  const parsedFiles = parseCommitFiles(fileList.stdout);
  const patch = await run(
    canonicalRoot,
    [
      "diff-tree",
      ...common,
      "-p",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      ...comparison,
      "--",
    ],
    historyRunOptions(options, {
      maxOutputBytes: GIT_HISTORY_LIMITS.commitDiffBytes + 1,
      truncateOutput: true,
      failureMessage: "Unable to read the diff for this commit.",
    }),
  );
  const diffTruncated = patch.truncated
    || patch.stdout.length > GIT_HISTORY_LIMITS.commitDiffBytes;
  return {
    sha: fullSha,
    shortSha: /^[0-9a-f]{4,64}$/u.test(shortSha) ? shortSha : fullSha.slice(0, 7),
    subject: boundedText(subject, GIT_HISTORY_LIMITS.subjectCharacters),
    body,
    bodyTruncated,
    authorName: boundedText(authorName, GIT_HISTORY_LIMITS.authorNameCharacters),
    authorDate,
    parents,
    isMerge: parents.length > 1,
    files: parsedFiles.files,
    filesTruncated: parsedFiles.truncated || fileList.truncated,
    diff: utf8Prefix(patch.stdout, GIT_HISTORY_LIMITS.commitDiffBytes),
    diffTruncated,
  };
}
