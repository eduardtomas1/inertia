import type {
  GitPreMergeArea,
  GitPreMergeCheck,
  GitPreMergeConfidence,
  GitPreMergeEvidenceState,
  GitPreMergeFile,
  GitPreMergePlatformCoverage,
  GitPreMergeReviewThread,
} from "../../shared/contracts";
import {
  RestrictedCliError,
  runRestrictedCli,
} from "../restricted-cli-runner";
import {
  githubRepositorySlug,
  resolveGitHubCli,
  verifiedGitHubPullRequestUrl,
  type GitHubPullRequestDependencies,
} from "./github-pull-request";
import { inspectGitRemoteRouting } from "./remote-routing";
import { runGitInspection } from "./runner";
import { getRepositoryStatus } from "./status";
import { GitError, type GitRepositoryStatus } from "./types";

const MAX_GITHUB_OUTPUT_BYTES = 1024 * 1024;
const MAX_LOCAL_FILES = 100;
const MAX_REMOTE_FILES = 200;
const MAX_CHECKS = 100;
const MAX_REVIEW_THREADS = 100;
const MAX_ASSOCIATED_PULL_REQUESTS = 100;
const MAX_REVIEW_BODY_CHARS = 2_000;
const MAX_AUTHOR_CLAIM_CHARS = 6_000;

type UnknownRecord = Record<string, unknown>;

interface GitHubPreMergeDependencies extends GitHubPullRequestDependencies {
  now?: () => Date;
  runCli?: typeof runRestrictedCli;
}

interface PullRequestDetails {
  number: number;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  headBranch: string;
  head: string;
  baseBranch: string;
  mergeState: string;
  reviewDecision: string | null;
  updatedAt: string;
  body: string;
  changedFiles: number;
  checks: GitPreMergeCheck[];
  checksTruncated: boolean;
  files: GitPreMergeFile[];
  filesTruncated: boolean;
}

interface PullRequestDiscovery {
  number: number;
  repositorySlug: string;
  repositoryBaseUrl: string;
}

interface ReviewThreadResult {
  head: string;
  updatedAt: string;
  threads: GitPreMergeReviewThread[];
  truncated: boolean;
}

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function integer(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallback;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedText(value: string, maxCharacters: number): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= maxCharacters) return { value, truncated: false };
  return {
    value: `${value.slice(0, Math.max(0, maxCharacters - 1)).trimEnd()}…`,
    truncated: true,
  };
}

function safeGitHubUrl(value: unknown, repositoryBaseUrl: string): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const candidate = new URL(value);
    const repository = new URL(repositoryBaseUrl);
    if (
      candidate.protocol !== "https:"
      || candidate.username
      || candidate.password
      || candidate.origin !== repository.origin
      || !candidate.pathname.toLowerCase().startsWith(
        `${repository.pathname.toLowerCase()}/`,
      )
    ) {
      return null;
    }
    candidate.search = "";
    return candidate.toString();
  } catch {
    return null;
  }
}

function safePath(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || /[\0\r\n]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function affectedArea(path: string): string {
  if (path.startsWith("src/renderer/")) return "Renderer";
  if (path.startsWith("src/main/")) return "Electron main";
  if (path.startsWith("src/preload/")) return "Preload bridge";
  if (path.startsWith("src/server/")) return "Local runtime";
  if (path.startsWith("src/node/")) return "Node contracts";
  if (path.startsWith("src/shared/")) return "Shared contracts";
  if (path.startsWith("tests/")) return "Tests";
  if (path.startsWith(".github/")) return "CI and release";
  if (path.startsWith("scripts/") || path.startsWith("electron-builder")) {
    return "Build and packaging";
  }
  if (path.startsWith("docs/") || path === "README.md") return "Documentation";
  if (path === "package.json" || path === "package-lock.json") {
    return "Dependencies";
  }
  const root = path.split("/", 1)[0];
  return root ? root : "Repository root";
}

function checkState(value: UnknownRecord): GitPreMergeEvidenceState {
  const status = text(value.status).toUpperCase();
  const conclusion = text(value.conclusion || value.state).toUpperCase();
  if (["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"]
    .includes(status || conclusion)) return "pending";
  if (["SUCCESS", "SUCCESSFUL"].includes(conclusion)) return "passed";
  if (["FAILURE", "FAILED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]
    .includes(conclusion)) return "failed";
  if (conclusion === "SKIPPED") return "skipped";
  if (conclusion === "CANCELLED") return "cancelled";
  if (conclusion === "NEUTRAL") return "neutral";
  return status === "COMPLETED" ? "unknown" : "pending";
}

function parseCheck(value: unknown, repositoryBaseUrl: string): GitPreMergeCheck | null {
  if (!record(value)) return null;
  const name = text(value.name || value.context).trim();
  if (!name) return null;
  return {
    name: boundedText(name, 240).value,
    workflow: text(value.workflowName).trim()
      ? boundedText(text(value.workflowName).trim(), 240).value
      : null,
    state: checkState(value),
    detailsUrl: safeGitHubUrl(
      value.detailsUrl || value.targetUrl,
      repositoryBaseUrl,
    ),
    startedAt: text(value.startedAt).trim()
      ? boundedText(text(value.startedAt).trim(), 64).value
      : null,
    completedAt: text(value.completedAt).trim()
      ? boundedText(text(value.completedAt).trim(), 64).value
      : null,
  };
}

function parseFile(value: unknown): GitPreMergeFile | null {
  if (!record(value)) return null;
  const path = safePath(value.path);
  if (
    !path
    || !isNonNegativeInteger(value.additions)
    || !isNonNegativeInteger(value.deletions)
  ) return null;
  return {
    path,
    area: affectedArea(path),
    insertions: value.additions,
    deletions: value.deletions,
  };
}

function parsePullRequest(
  value: unknown,
  repositoryBaseUrl: string,
): PullRequestDetails | null {
  if (!record(value)) return null;
  const number = integer(value.number);
  const url = verifiedGitHubPullRequestUrl(
    text(value.url),
    repositoryBaseUrl,
  );
  const head = text(value.headRefOid).toLowerCase();
  const headBranch = text(value.headRefName);
  const updatedAt = text(value.updatedAt).trim();
  if (
    number < 1
    || !url
    || !headBranch
    || !/^[0-9a-f]{40,64}$/u.test(head)
    || !Number.isFinite(Date.parse(updatedAt))
  ) {
    return null;
  }
  if (!Array.isArray(value.files) || !isNonNegativeInteger(value.changedFiles)) {
    throw new GitError(
      "operation-failed",
      "GitHub returned incomplete changed-file evidence.",
    );
  }
  const rawChecks = Array.isArray(value.statusCheckRollup)
    ? value.statusCheckRollup
    : [];
  const checks = rawChecks
      .map((entry) => parseCheck(entry, repositoryBaseUrl))
      .filter((entry): entry is GitPreMergeCheck => entry !== null)
      .slice(0, MAX_CHECKS);
  const rawFiles = value.files;
  const files = rawFiles
    .map(parseFile)
    .filter((entry): entry is GitPreMergeFile => entry !== null)
    .slice(0, MAX_REMOTE_FILES);
  const uniqueFilePaths = new Set(files.map(({ path }) => path));
  return {
    number,
    url,
    title: boundedText(text(value.title, `Pull request #${number}`), 512).value,
    state: boundedText(text(value.state, "UNKNOWN"), 32).value.toUpperCase(),
    draft: value.isDraft === true,
    headBranch: boundedText(headBranch, 240).value,
    head,
    baseBranch: boundedText(text(value.baseRefName, "unknown"), 240).value,
    mergeState: boundedText(
      text(value.mergeStateStatus, "UNKNOWN"),
      64,
    ).value.toUpperCase(),
    reviewDecision: text(value.reviewDecision).trim()
      ? boundedText(text(value.reviewDecision).trim(), 64).value.toUpperCase()
      : null,
    updatedAt: boundedText(updatedAt, 64).value,
    body: text(value.body),
    changedFiles: value.changedFiles,
    checks,
    checksTruncated: rawChecks.length >= MAX_CHECKS || rawChecks.length > checks.length,
    files,
    filesTruncated: rawFiles.length >= MAX_REMOTE_FILES
      || rawFiles.length !== files.length
      || files.length !== value.changedFiles
      || uniqueFilePaths.size !== files.length,
  };
}

function parsePullRequestObject(
  source: string,
  repositoryBaseUrl: string,
  expectedNumber: number,
): PullRequestDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new GitError("operation-failed", "GitHub returned malformed pull request evidence.");
  }
  const details = parsePullRequest(parsed, repositoryBaseUrl);
  if (!details || details.number !== expectedNumber) {
    throw new GitError(
      "operation-failed",
      "GitHub returned evidence for a different pull request.",
    );
  }
  return details;
}

function parsePullRequestList(
  source: string,
  repositoryBaseUrl: string,
  branch: string,
): PullRequestDetails | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new GitError("operation-failed", "GitHub returned malformed pull request evidence.");
  }
  if (!Array.isArray(parsed)) {
    throw new GitError("operation-failed", "GitHub returned malformed pull request evidence.");
  }
  const matches = parsed
    .map((entry) => parsePullRequest(entry, repositoryBaseUrl))
    .filter((entry): entry is PullRequestDetails => (
      entry !== null
      && entry.state === "OPEN"
      && entry.headBranch === branch
    ));
  if (matches.length > 1) {
    throw new GitError(
      "operation-failed",
      "GitHub returned multiple open pull requests for this exact branch.",
    );
  }
  return matches[0] ?? null;
}

function parseAssociatedPullRequests(
  source: string,
  sourceRepositorySlug: string,
  branch: string,
): PullRequestDiscovery | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new GitError("operation-failed", "GitHub returned malformed pull request discovery evidence.");
  }
  if (!Array.isArray(parsed)) {
    throw new GitError("operation-failed", "GitHub returned malformed pull request discovery evidence.");
  }
  if (parsed.length >= MAX_ASSOCIATED_PULL_REQUESTS) {
    throw new GitError("operation-failed", "GitHub pull request discovery evidence is truncated.");
  }

  const matches: PullRequestDiscovery[] = [];
  for (const value of parsed) {
    if (!record(value) || !record(value.head) || !record(value.base)) {
      throw new GitError("operation-failed", "GitHub returned incomplete pull request discovery evidence.");
    }
    const headRepository = record(value.head.repo) ? value.head.repo : null;
    const baseRepository = record(value.base.repo) ? value.base.repo : null;
    if (!headRepository || !baseRepository) {
      throw new GitError("operation-failed", "GitHub returned incomplete pull request discovery evidence.");
    }
    const discoveredHead = text(value.head.sha).toLowerCase();
    const discoveredBranch = text(value.head.ref);
    const discoveredSourceSlug = text(headRepository.full_name);
    const state = text(value.state).toUpperCase();
    if (
      !/^[0-9a-f]{40,64}$/u.test(discoveredHead)
      || !discoveredBranch
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(discoveredSourceSlug)
      || !state
    ) {
      throw new GitError("operation-failed", "GitHub returned incomplete pull request discovery evidence.");
    }
    if (
      state !== "OPEN"
      || discoveredBranch !== branch
      || discoveredSourceSlug.toLowerCase() !== sourceRepositorySlug.toLowerCase()
    ) continue;

    const number = integer(value.number);
    const repositoryBaseUrl = text(baseRepository.html_url).replace(/\/+$/u, "");
    const reportedSlug = text(baseRepository.full_name);
    let repositorySlug: string;
    try {
      repositorySlug = githubRepositorySlug(repositoryBaseUrl);
    } catch {
      throw new GitError("operation-failed", "GitHub returned incomplete pull request discovery evidence.");
    }
    if (
      number < 1
      || repositorySlug.toLowerCase() !== reportedSlug.toLowerCase()
    ) {
      throw new GitError("operation-failed", "GitHub returned incomplete pull request discovery evidence.");
    }
    matches.push({ number, repositorySlug, repositoryBaseUrl });
  }
  if (matches.length > 1) {
    throw new GitError(
      "operation-failed",
      "GitHub returned multiple open pull requests for this exact head.",
    );
  }
  return matches[0] ?? null;
}

function parseReviewThreads(
  source: string,
  repositoryBaseUrl: string,
  expectedNumber: number,
): ReviewThreadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new GitError("operation-failed", "GitHub returned malformed review evidence.");
  }
  if (!record(parsed) || !record(parsed.data) || !record(parsed.data.repository)) {
    throw new GitError("operation-failed", "GitHub returned malformed review evidence.");
  }
  const pullRequest = parsed.data.repository.pullRequest;
  if (!record(pullRequest) || integer(pullRequest.number) !== expectedNumber) {
    throw new GitError("operation-failed", "GitHub returned review evidence for a different pull request.");
  }
  const head = text(pullRequest.headRefOid).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(head) || !record(pullRequest.reviewThreads)) {
    throw new GitError("operation-failed", "GitHub returned incomplete review evidence.");
  }
  const pageInfo = pullRequest.reviewThreads.pageInfo;
  if (
    !Array.isArray(pullRequest.reviewThreads.nodes)
    || !record(pageInfo)
    || typeof pageInfo.hasNextPage !== "boolean"
  ) {
    throw new GitError("operation-failed", "GitHub returned incomplete review evidence.");
  }
  const nodes = pullRequest.reviewThreads.nodes;
  const updatedAt = text(pullRequest.updatedAt).trim();
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new GitError("operation-failed", "GitHub returned incomplete review evidence.");
  }
  const threads: GitPreMergeReviewThread[] = [];
  let incomplete = false;
  for (const node of nodes) {
    if (threads.length >= MAX_REVIEW_THREADS) {
      incomplete = true;
      continue;
    }
    if (
      !record(node)
      || typeof node.isResolved !== "boolean"
      || typeof node.isOutdated !== "boolean"
    ) {
      incomplete = true;
      continue;
    }
    if (node.isResolved) continue;
    const path = safePath(node.path);
    const comments = record(node.comments) && Array.isArray(node.comments.nodes)
      ? node.comments.nodes.filter(record)
      : [];
    const first = comments[0];
    if (!path || !first) {
      incomplete = true;
      continue;
    }
    const codexComment = comments.find((comment) => {
      const author = record(comment.author) ? text(comment.author.login) : "";
      return author.toLowerCase().includes("codex");
    });
    const source = codexComment ?? first;
    const author = record(source.author)
      ? text(source.author.login, "Unknown reviewer")
      : "Unknown reviewer";
    const body = boundedText(text(source.body).trim(), MAX_REVIEW_BODY_CHARS).value;
    if (!body) {
      incomplete = true;
      continue;
    }
    threads.push({
      id: boundedText(text(node.id, `thread-${threads.length + 1}`), 256).value,
      path,
      line: Number.isSafeInteger(node.line) && Number(node.line) >= 1
        ? Number(node.line)
        : null,
      author: boundedText(author, 128).value,
      body,
      url: safeGitHubUrl(source.url, repositoryBaseUrl),
      codex: Boolean(codexComment),
      outdated: node.isOutdated,
    });
  }
  threads.sort((left, right) => Number(right.codex) - Number(left.codex));
  return {
    head,
    updatedAt,
    threads,
    truncated: incomplete
      || pageInfo.hasNextPage
      || nodes.length > MAX_REVIEW_THREADS,
  };
}

async function currentHead(
  root: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const result = await runGitInspection(root, ["rev-parse", "--verify", "HEAD"], {
      signal,
      maxOutputBytes: 256,
      failureMessage: "Unable to inspect the current commit.",
    });
    const head = result.stdout.toString("utf8").trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) {
      throw new GitError("operation-failed", "Git returned an invalid current commit.");
    }
    return head;
  } catch (error) {
    if (error instanceof GitError && error.code === "operation-failed") return null;
    throw error;
  }
}

function localEvidence(status: GitRepositoryStatus, head: string | null) {
  return {
    branch: status.branch,
    head,
    dirty: !status.clean || status.truncated,
    files: status.files.slice(0, MAX_LOCAL_FILES).map(({ path }) => path),
    filesTruncated: status.truncated || status.files.length > MAX_LOCAL_FILES,
  };
}

function emptyConfidence(
  now: Date,
  status: GitRepositoryStatus,
  head: string | null,
  state: "no-pull-request" | "unavailable",
  reason: string,
): GitPreMergeConfidence {
  return {
    generatedAt: now.toISOString(),
    state,
    unavailableReason: state === "unavailable" ? reason : null,
    local: localEvidence(status, head),
    github: null,
    identity: {
      state: "unavailable",
      detail: reason,
    },
    checks: [],
    checksTruncated: false,
    platforms: ["Linux", "Windows", "macOS"].map((platform) => ({
      platform: platform as GitPreMergePlatformCoverage["platform"],
      state: "missing",
      checks: [],
    })),
    reviewThreads: [],
    reviewThreadsTruncated: false,
    files: [],
    totalFiles: 0,
    filesTruncated: false,
    areas: [],
    changedTestFiles: [],
    focusedTestChecks: [],
    bundle: {
      state: "not-published",
      summary: "No authoritative bundle delta is available for this head.",
    },
    authorClaim: null,
    mergeReadiness: { state: "unknown", blockers: [reason] },
    releaseReadiness: {
      state: "not-proven",
      detail: "Release readiness requires the exact version-tag release workflow; pull-request evidence cannot prove it.",
    },
  };
}

function aggregateEvidenceState(
  states: readonly GitPreMergeEvidenceState[],
): GitPreMergeEvidenceState {
  if (states.length === 0) return "missing";
  if (states.some((state) => state === "failed")) return "failed";
  if (states.some((state) => state === "cancelled")) return "cancelled";
  if (states.some((state) => state === "pending")) return "pending";
  if (states.some((state) => state === "skipped")) return "skipped";
  if (states.some((state) => state === "neutral")) return "neutral";
  if (states.some((state) => state === "unknown")) return "unknown";
  return states.every((state) => state === "passed") ? "passed" : "unknown";
}

function platformCoverage(checks: readonly GitPreMergeCheck[]): GitPreMergePlatformCoverage[] {
  const patterns = [
    { platform: "Linux" as const, pattern: /\b(?:linux|ubuntu)\b/iu },
    { platform: "Windows" as const, pattern: /\bwindows\b/iu },
    { platform: "macOS" as const, pattern: /\b(?:macos|mac os)\b/iu },
  ];
  return patterns.map(({ platform, pattern }) => {
    const matches = checks.filter((check) => pattern.test(
      `${check.workflow ?? ""} ${check.name}`,
    ));
    return {
      platform,
      state: aggregateEvidenceState(matches.map(({ state }) => state)),
      checks: matches.map(({ name }) => name),
    };
  });
}

function affectedAreas(files: readonly GitPreMergeFile[]): GitPreMergeArea[] {
  const totals = new Map<string, number>();
  for (const file of files) totals.set(file.area, (totals.get(file.area) ?? 0) + 1);
  return [...totals]
    .map(([name, count]) => ({ name, files: count }))
    .sort((left, right) => right.files - left.files || left.name.localeCompare(right.name));
}

function isTestFile(path: string): boolean {
  return path.startsWith("tests/")
    || /(?:^|\/)__tests__(?:\/|$)/u.test(path)
    || /\.(?:test|spec)\.[^/]+$/u.test(path);
}

function isFocusedTestCheck(check: GitPreMergeCheck): boolean {
  return /\b(?:test|unit|e2e|coverage|portable)\b/iu.test(
    `${check.workflow ?? ""} ${check.name}`,
  );
}

function readiness(
  identityState: GitPreMergeConfidence["identity"]["state"],
  status: GitRepositoryStatus,
  details: PullRequestDetails,
  checks: readonly GitPreMergeCheck[],
  platforms: readonly GitPreMergePlatformCoverage[],
  threads: readonly GitPreMergeReviewThread[],
  completeEvidence: boolean,
): GitPreMergeConfidence["mergeReadiness"] {
  const blockers: string[] = [];
  let pending = false;
  if (!completeEvidence) blockers.push("GitHub evidence is incomplete or truncated.");
  if (identityState !== "exact") blockers.push("The local and GitHub heads are not an exact stable match.");
  if (!status.clean || status.truncated) blockers.push("The local repository has changes that are not represented by the PR head.");
  if (details.draft) blockers.push("The pull request is still a draft.");
  if (details.state !== "OPEN") blockers.push("The pull request is not open.");
  if (checks.length === 0) blockers.push("GitHub reported no checks for this head.");
  const checkState = aggregateEvidenceState(checks.map(({ state }) => state));
  if (checkState === "pending") {
    blockers.push("One or more checks are still pending.");
    pending = true;
  } else if (checkState !== "passed") {
    blockers.push("Every reported check must pass; skipped, neutral, cancelled, failed, and unknown checks are not green.");
  }
  for (const platform of platforms) {
    if (platform.state === "pending") pending = true;
    if (platform.state !== "passed") {
      blockers.push(`${platform.platform} coverage is ${platform.state}.`);
    }
  }
  if (threads.length > 0) {
    blockers.push(`${threads.length} actionable review ${threads.length === 1 ? "thread remains" : "threads remain"}.`);
  }
  if (details.reviewDecision === "CHANGES_REQUESTED") {
    blockers.push("GitHub records changes requested.");
  } else if (details.reviewDecision === "REVIEW_REQUIRED") {
    blockers.push("GitHub still requires review.");
  }
  if (details.mergeState === "UNKNOWN") {
    blockers.push("GitHub is still calculating mergeability.");
    pending = true;
  } else if (details.mergeState !== "CLEAN") {
    blockers.push(`GitHub merge state is ${details.mergeState.toLocaleLowerCase("en-US")}.`);
  }
  if (blockers.length === 0) return { state: "ready", blockers };
  return { state: pending ? "pending" : "blocked", blockers };
}

function githubUnavailableReason(error: unknown): string {
  if (error instanceof GitError) return error.message;
  if (error instanceof RestrictedCliError && error.code === "unavailable") {
    return "GitHub CLI is not installed or could not be started.";
  }
  return "GitHub evidence could not be loaded. Confirm that GitHub CLI is signed in and can read this repository.";
}

export async function inspectGitHubPreMergeConfidence(
  repositoryPath: string,
  options: { signal?: AbortSignal } = {},
  dependencies: GitHubPreMergeDependencies = {},
): Promise<GitPreMergeConfidence> {
  const now = (dependencies.now ?? (() => new Date()))();
  const initialStatus = await getRepositoryStatus(repositoryPath, {
    signal: options.signal,
  });
  const initialHead = await currentHead(repositoryPath, options.signal);
  if (!initialStatus.branch || !initialHead) {
    return emptyConfidence(
      now,
      initialStatus,
      initialHead,
      "unavailable",
      "Check out a branch with a commit before loading pre-merge evidence.",
    );
  }
  const routing = await inspectGitRemoteRouting(
    repositoryPath,
    initialStatus.branch,
    { signal: options.signal },
  );
  if (!routing.target || routing.target.forge !== "github") {
    return emptyConfidence(
      now,
      initialStatus,
      initialHead,
      "unavailable",
      "Authoritative pre-merge evidence is currently available for GitHub repositories.",
    );
  }
  const sourceRepositorySlug = githubRepositorySlug(routing.target.baseUrl);
  const runCli = dependencies.runCli ?? runRestrictedCli;
  let gh: Awaited<ReturnType<typeof resolveGitHubCli>>;
  try {
    gh = await resolveGitHubCli(dependencies);
  } catch (error) {
    return emptyConfidence(
      now,
      initialStatus,
      initialHead,
      "unavailable",
      githubUnavailableReason(error),
    );
  }
  const listFields = [
    "number", "url", "title", "state", "isDraft", "headRefName",
    "headRefOid", "baseRefName", "mergeStateStatus", "reviewDecision",
    "updatedAt", "statusCheckRollup", "files", "changedFiles", "body",
  ].join(",");
  let discovery: PullRequestDiscovery | null;
  try {
    const result = await runCli(
      gh.executable,
      [
        "api", "--method", "GET",
        `repos/${sourceRepositorySlug}/commits/${initialHead}/pulls?per_page=${MAX_ASSOCIATED_PULL_REQUESTS}`,
      ],
      {
        cwd: repositoryPath,
        environment: gh.environment,
        signal: options.signal,
        timeoutMs: 30_000,
        maxOutputBytes: MAX_GITHUB_OUTPUT_BYTES,
        failureMessage: "GitHub could not discover pull requests for this exact head.",
      },
      dependencies,
    );
    discovery = parseAssociatedPullRequests(
      result.stdout,
      sourceRepositorySlug,
      initialStatus.branch,
    );
  } catch (error) {
    return emptyConfidence(
      now,
      initialStatus,
      initialHead,
      "unavailable",
      githubUnavailableReason(error),
    );
  }
  if (!discovery) {
    const [finalStatus, finalHead] = await Promise.all([
      getRepositoryStatus(repositoryPath, { signal: options.signal }),
      currentHead(repositoryPath, options.signal),
    ]);
    const changed = initialHead !== finalHead
      || initialStatus.branch !== finalStatus.branch;
    const confidence = emptyConfidence(
      now,
      finalStatus,
      finalHead,
      "no-pull-request",
      changed
        ? "The local head changed while GitHub was checked. Refresh before relying on this result."
        : `GitHub has no open pull request for ${initialStatus.branch} at ${initialHead.slice(0, 8)}.`,
    );
    if (changed) confidence.identity.state = "changed";
    return confidence;
  }

  const { repositorySlug, repositoryBaseUrl } = discovery;
  let details: PullRequestDetails;
  try {
    const result = await runCli(
      gh.executable,
      [
        "pr", "view", String(discovery.number), "--repo", repositorySlug,
        "--json", listFields,
      ],
      {
        cwd: repositoryPath,
        environment: gh.environment,
        signal: options.signal,
        timeoutMs: 30_000,
        maxOutputBytes: MAX_GITHUB_OUTPUT_BYTES,
        failureMessage: "GitHub could not load pull request evidence.",
      },
      dependencies,
    );
    details = parsePullRequestObject(
      result.stdout,
      repositoryBaseUrl,
      discovery.number,
    );
  } catch (error) {
    return emptyConfidence(
      now,
      initialStatus,
      initialHead,
      "unavailable",
      githubUnavailableReason(error),
    );
  }

  const [owner = "", name = ""] = repositorySlug.split("/");
  const query = [
    "query($owner:String!,$name:String!,$number:Int!){",
    "repository(owner:$owner,name:$name){pullRequest(number:$number){",
    "number headRefOid updatedAt reviewThreads(first:100){",
    "nodes{id isResolved isOutdated path line comments(first:1){nodes{author{login} body url}}}",
    "pageInfo{hasNextPage}}}}}",
  ].join("");
  let reviewEvidence: ReviewThreadResult | null = null;
  let reviewEvidenceReason: string | null = null;
  try {
    const result = await runCli(
      gh.executable,
      ["api", "graphql", "--input", "-"],
      {
        cwd: repositoryPath,
        environment: gh.environment,
        input: JSON.stringify({
          query,
          variables: { owner, name, number: details.number },
        }),
        signal: options.signal,
        timeoutMs: 30_000,
        maxOutputBytes: MAX_GITHUB_OUTPUT_BYTES,
        failureMessage: "GitHub could not load pull request review threads.",
      },
      dependencies,
    );
    reviewEvidence = parseReviewThreads(
      result.stdout,
      repositoryBaseUrl,
      details.number,
    );
  } catch (error) {
    reviewEvidenceReason = githubUnavailableReason(error);
  }
  let finalDetailsLoaded = false;
  try {
    const result = await runCli(
      gh.executable,
      [
        "pr", "view", String(details.number), "--repo", repositorySlug,
        "--json", listFields,
      ],
      {
        cwd: repositoryPath,
        environment: gh.environment,
        signal: options.signal,
        timeoutMs: 30_000,
        maxOutputBytes: MAX_GITHUB_OUTPUT_BYTES,
        failureMessage: "GitHub could not revalidate pull request evidence.",
      },
      dependencies,
    );
    details = parsePullRequestObject(
      result.stdout,
      repositoryBaseUrl,
      details.number,
    );
    finalDetailsLoaded = true;
  } catch (error) {
    reviewEvidenceReason ??= githubUnavailableReason(error);
  }
  const [finalStatus, finalHead] = await Promise.all([
    getRepositoryStatus(repositoryPath, { signal: options.signal }),
    currentHead(repositoryPath, options.signal),
  ]);
  const localChanged = initialHead !== finalHead
    || initialStatus.branch !== finalStatus.branch;
  const remoteChanged = reviewEvidence !== null
    && (reviewEvidence.head !== details.head
      || reviewEvidence.updatedAt !== details.updatedAt);
  const identityState: GitPreMergeConfidence["identity"]["state"] =
    localChanged || remoteChanged
      ? "changed"
      : finalHead === details.head && finalStatus.branch === details.headBranch
        ? "exact"
        : "mismatch";
  const identityDetail = identityState === "exact"
    ? `Local ${finalHead?.slice(0, 8)} exactly matches GitHub PR #${details.number}.`
    : identityState === "changed"
      ? "The local head or GitHub evidence changed while loading. Refresh before relying on any green state."
      : `Local ${finalHead?.slice(0, 8) ?? "head unavailable"} does not match GitHub ${details.head.slice(0, 8)}.`;
  const checks = details.checks;
  const platforms = platformCoverage(checks);
  const threads = reviewEvidence?.threads ?? [];
  const areas = affectedAreas(details.files);
  const authorClaim = details.body.trim()
    ? boundedText(details.body.trim(), MAX_AUTHOR_CLAIM_CHARS)
    : null;
  const completeEvidence = reviewEvidence !== null
    && finalDetailsLoaded
    && !reviewEvidence.truncated
    && !details.checksTruncated
    && !details.filesTruncated;
  const incompleteReason = reviewEvidenceReason
    ?? (reviewEvidence?.truncated
      ? "GitHub review-thread evidence is truncated."
      : details.checksTruncated
        ? "GitHub check evidence is truncated."
        : details.filesTruncated
          ? "GitHub changed-file evidence is truncated."
          : !finalDetailsLoaded
            ? "GitHub final-state revalidation did not complete."
            : null);
  const mergeReadiness = readiness(
    identityState,
    finalStatus,
    details,
    checks,
    platforms,
    threads,
    completeEvidence,
  );
  return {
    generatedAt: now.toISOString(),
    state: completeEvidence ? "ready" : "unavailable",
    unavailableReason: incompleteReason,
    local: localEvidence(finalStatus, finalHead),
    github: {
      repository: repositorySlug,
      number: details.number,
      url: details.url,
      title: details.title,
      state: details.state,
      draft: details.draft,
      headBranch: details.headBranch,
      head: details.head,
      baseBranch: details.baseBranch,
      mergeState: details.mergeState,
      reviewDecision: details.reviewDecision,
      updatedAt: details.updatedAt,
    },
    identity: { state: identityState, detail: identityDetail },
    checks,
    checksTruncated: details.checksTruncated,
    platforms,
    reviewThreads: threads,
    reviewThreadsTruncated: reviewEvidence?.truncated ?? false,
    files: details.files,
    totalFiles: details.changedFiles,
    filesTruncated: details.filesTruncated,
    areas,
    changedTestFiles: details.files.filter(({ path }) => isTestFile(path))
      .map(({ path }) => path),
    focusedTestChecks: checks.filter(isFocusedTestCheck).map(({ name }) => name),
    bundle: {
      state: "not-published",
      summary: "No authoritative bundle delta was published for this exact head. Passing CI may enforce bundle ceilings, but it is not a measured delta.",
    },
    authorClaim: authorClaim ? {
      source: "pull-request-body",
      body: authorClaim.value,
      truncated: authorClaim.truncated,
    } : null,
    mergeReadiness,
    releaseReadiness: {
      state: "not-proven",
      detail: "Inertia releases are proven only by the exact vMAJOR.MINOR.PATCH tag workflow across Linux, Windows, and macOS. This PR view does not claim release readiness.",
    },
  };
}

export const gitHubPreMergeTestSupport = {
  affectedArea,
  parseAssociatedPullRequests,
  parsePullRequestList,
  parseReviewThreads,
  platformCoverage,
};
