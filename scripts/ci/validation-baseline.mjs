import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_GIT_BYTES = 4 * 1024 * 1024;

export function boundedGit(args, cwd = process.cwd()) {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: MAX_GIT_BYTES, timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.status === 0 && !result.error ? result.stdout : null;
}

export function verificationContractAt(sha, cwd = process.cwd()) {
  if (!SHA.test(sha)) return null;
  const tree = boundedGit(["ls-tree", "-r", "-z", sha], cwd);
  if (tree === null) return null;
  const contract = tree.split("\0").filter((entry) => {
    const path = entry.slice(entry.indexOf("\t") + 1);
    return /^(?:\.github|scripts|tests|benchmarks)\//u.test(path)
      || (!path.includes("/") && !path.endsWith(".md"));
  }).sort();
  if (contract.length === 0) return null;
  return createHash("sha256").update(contract.join("\0")).digest("hex");
}

export function comparisonPaths(base, head, cwd = process.cwd()) {
  if (!SHA.test(base) || !SHA.test(head)) return null;
  // --no-renames deliberately represents a rename as deletion + addition;
  // both owners are classified, including moves into documentation paths.
  const result = boundedGit(["diff", "--no-renames", "--name-only", "-z", base, head], cwd);
  return result === null ? null : result.split("\0").filter(Boolean);
}

export async function selectMainBaseline({
  runs, head, repository, workflowId, currentRunId, contractAt, isAncestor, hasSuccessfulGate,
}) {
  const contract = contractAt(head);
  if (!contract) return { base: null, reason: "verification-contract-unavailable" };
  // Only repository Actions metadata can nominate a baseline. A PR artifact,
  // latest-push delta, cancelled run, foreign branch, or future run cannot.
  for (const run of runs) {
    if (!Number.isSafeInteger(run.id) || run.id >= currentRunId
      || run.workflow_id !== workflowId || run.path !== ".github/workflows/ci.yml"
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || run.event !== "push" || run.head_branch !== "main"
      || run.status !== "completed" || run.conclusion !== "success"
      || !SHA.test(run.head_sha) || run.head_sha === head
      || !isAncestor(run.head_sha, head)
      || contractAt(run.head_sha) !== contract
      || !await hasSuccessfulGate(run)) continue;
    return { base: run.head_sha, reason: `trusted-main-run:${run.id}` };
  }
  return { base: null, reason: "no-successful-compatible-main-ancestor" };
}

export function githubApi(endpoint, timeoutMs = 30_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Actions metadata deadline expired.");
  const result = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8", maxBuffer: MAX_GIT_BYTES, timeout: Math.min(30_000, Math.floor(timeoutMs)),
  });
  if (result.status !== 0 || result.error) throw new Error("Trusted Actions metadata is unavailable.");
  return JSON.parse(result.stdout);
}

export function currentRunJobs(repository, runId, deadlineAt = Date.now() + 30_000) {
  const jobs = [];
  // This graph has fewer than 100 jobs. Still support bounded pagination and
  // reject a truncated response rather than silently losing a required shard.
  for (let page = 1; page <= 3; page += 1) {
    const result = githubApi(`repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      deadlineAt - Date.now());
    if (!Array.isArray(result.jobs)) throw new Error("Actions job metadata is malformed.");
    jobs.push(...result.jobs);
    if (jobs.length >= result.total_count) return jobs;
  }
  throw new Error("Actions job evidence exceeded its bounded page count.");
}

export async function resolveMainBaseline({ head, repository, runId }) {
  try {
    const current = githubApi(`repos/${repository}/actions/runs/${runId}`);
    if (current.id !== runId || current.head_sha !== head
      || current.event !== "push" || current.head_branch !== "main"
      || current.repository?.full_name !== repository) throw new Error("Current run identity mismatch.");
    const listing = githubApi(`repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=50`);
    if (!Array.isArray(listing.workflow_runs)) throw new Error("Missing run metadata.");
    return await selectMainBaseline({
      runs: listing.workflow_runs, head, repository, workflowId: current.workflow_id,
      currentRunId: runId, contractAt: verificationContractAt,
      isAncestor: (base, candidate) => boundedGit(["merge-base", "--is-ancestor", base, candidate]) !== null,
      hasSuccessfulGate: async (run) => {
        const matches = currentRunJobs(repository, run.id).filter((job) => job.name === "merge-ready");
        return matches.length === 1 && matches[0].run_id === run.id
          && matches[0].head_sha === run.head_sha && matches[0].status === "completed"
          && matches[0].conclusion === "success";
      },
    });
  } catch {
    // API limits, unavailable permissions, shallow/missing history, and every
    // ambiguous identity expand evidence. None creates a green baseline.
    return { base: null, reason: "trusted-main-baseline-unavailable" };
  }
}
