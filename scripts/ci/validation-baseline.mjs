import { spawnSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_GIT_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_RUNS = 20;
const LOOKUP_DEADLINE_MS = 120_000;

function metadataError(code) {
  return Object.assign(new Error("Trusted Actions metadata is unavailable."), { code });
}

export function boundedGit(args, cwd = process.cwd()) {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: MAX_GIT_BYTES, timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.status === 0 && !result.error ? result.stdout : null;
}

export function comparisonPaths(base, head, cwd = process.cwd()) {
  if (!SHA.test(base) || !SHA.test(head)) return null;
  // --no-renames deliberately represents a rename as deletion + addition;
  // both owners are classified, including moves into documentation paths.
  const result = boundedGit(["diff", "--no-renames", "--name-only", "-z", base, head], cwd);
  return result === null ? null : result.split("\0").filter(Boolean);
}

export function githubApi(endpoint, timeoutMs = 30_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw metadataError("metadata-deadline");
  const result = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8", maxBuffer: MAX_GIT_BYTES, timeout: Math.min(30_000, Math.floor(timeoutMs)),
  });
  if (result.status !== 0 || result.error) {
    throw metadataError(result.error?.code === "ETIMEDOUT" ? "api-timeout" : "api-command-failed");
  }
  try { return JSON.parse(result.stdout); }
  catch { throw metadataError("api-json-invalid"); }
}

export function currentRunJobs(repository, runId, deadlineAt = Date.now() + 30_000, api = githubApi) {
  const jobs = [];
  let total;
  // This graph has fewer than 100 jobs. Still support bounded pagination and
  // reject a truncated response rather than silently losing a required shard.
  for (let page = 1; page <= 3; page += 1) {
    const result = api(`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      deadlineAt - Date.now());
    if (!Array.isArray(result?.jobs) || !Number.isSafeInteger(result.total_count)
      || result.total_count < 0 || result.total_count > 300
      || (total !== undefined && total !== result.total_count)) throw new Error("Actions job metadata is malformed.");
    total = result.total_count;
    jobs.push(...result.jobs);
    if (jobs.length === total) return jobs;
    if (jobs.length > total || result.jobs.length !== 100) throw new Error("Actions job metadata is truncated.");
  }
  throw new Error("Actions job evidence exceeded its bounded page count.");
}

function reuseFailure(reason) {
  return { reused: null, reason };
}

export async function resolveCertifiedPullRequest({
  head, repository, runId, api = githubApi, git = boundedGit, now = Date.now,
}) {
  const deadlineAt = now() + LOOKUP_DEADLINE_MS;
  const remaining = () => {
    const milliseconds = deadlineAt - now();
    if (milliseconds <= 0) throw metadataError("metadata-deadline");
    return milliseconds;
  };
  try {
    if (!SHA.test(head) || !Number.isSafeInteger(runId) || runId < 1) return reuseFailure("reuse-metadata-invalid");
    const current = api(`repos/${repository}/actions/runs/${runId}`, remaining());
    if (current?.id !== runId || current.head_sha !== head
      || current.event !== "push" || current.head_branch !== "main"
      || current.repository?.full_name !== repository) return reuseFailure("current-run-identity");
    const parents = git(["rev-list", "--parents", "-n", "1", head])?.trim().split(" ") ?? [];
    const headTree = git(["rev-parse", `${head}^{tree}`])?.trim();
    if (parents.length !== 2 || parents[0] !== head || !SHA.test(parents[1]) || !SHA.test(headTree ?? "")) {
      return reuseFailure("main-commit-history-unavailable");
    }
    const parent = parents[1];
    const pulls = api(`repos/${repository}/commits/${head}/pulls`, remaining());
    if (!Array.isArray(pulls)) return reuseFailure("pull-request-list-invalid");
    const merged = pulls.filter((pull) => pull?.merged_at && pull.merge_commit_sha === head
      && pull.base?.ref === "main" && pull.base?.repo?.full_name === repository
      && pull.head?.repo?.full_name === repository);
    if (merged.length !== 1) return reuseFailure("pull-request-not-unique");
    const pull = merged[0];
    const sourceHead = pull.head.sha;
    if (!Number.isSafeInteger(pull.number) || pull.number < 1 || !SHA.test(sourceHead ?? "")) {
      return reuseFailure("pull-request-identity-invalid");
    }
    const sourceCommit = api(`repos/${repository}/git/commits/${sourceHead}`, remaining());
    if (sourceCommit?.sha !== sourceHead || sourceCommit.tree?.sha !== headTree) return reuseFailure("tree-mismatch");
    const comparison = api(`repos/${repository}/compare/${parent}...${sourceHead}`, remaining());
    if (!["ahead", "identical"].includes(comparison?.status)
      || comparison.merge_base_commit?.sha !== parent) return reuseFailure("parent-not-ancestor");
    const listing = api(`repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${sourceHead}&status=completed&per_page=${MAX_CANDIDATE_RUNS}`, remaining());
    if (!Array.isArray(listing?.workflow_runs)) return reuseFailure("run-list-invalid");
    const candidates = listing.workflow_runs.filter((run) => run && Number.isSafeInteger(run.id)
      && run.id > 0 && run.id < runId && run.event === "pull_request" && run.head_sha === sourceHead
      && run.path === ".github/workflows/ci.yml" && run.status === "completed"
      && run.repository?.full_name === repository && run.head_repository?.full_name === repository)
      .sort((left, right) => right.id - left.id).slice(0, MAX_CANDIDATE_RUNS);
    for (const run of candidates) {
      const gates = currentRunJobs(repository, run.id, Math.min(deadlineAt, now() + 30_000), api)
        .filter((job) => job.name === "merge-ready");
      if (gates.length === 1 && gates[0].run_id === run.id && gates[0].head_sha === sourceHead
        && gates[0].status === "completed" && gates[0].conclusion === "success") {
        return {
          reused: { runId: run.id, pullRequest: pull.number, sourceHead },
          base: parent,
          reason: `certified-pull-request-run:${run.id}`,
        };
      }
    }
    return reuseFailure("no-successful-merge-ready");
  } catch (error) {
    return reuseFailure(["metadata-deadline", "api-timeout", "api-command-failed", "api-json-invalid"]
      .includes(error?.code) ? error.code : "metadata-or-history-unavailable");
  }
}
