import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_GIT_BYTES = 4 * 1024 * 1024;
const MAX_BASELINES = 50;
const MAX_DIAGNOSTICS = 10;

function metadataError(code) {
  return Object.assign(new Error("Trusted Actions metadata is unavailable."), { code });
}

function isContractPath(path) {
  return /^(?:\.github|scripts|tests|benchmarks)\//u.test(path)
    || (!path.includes("/") && !path.endsWith(".md"));
}

// Shadow hypothesis only. Preserve inventory and modes: adding, deleting or
// moving a test still invalidates compatibility. Helpers, setup, native E2E,
// resource policy, test discovery and every other control surface stay exact.
function isRendererDomLeaf(entry) {
  return /^100644 blob [0-9a-f]{40}\ttests\/renderer\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.dom\.test\.tsx$/u.test(entry);
}

export function boundedGit(args, cwd = process.cwd()) {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: MAX_GIT_BYTES, timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.status === 0 && !result.error ? result.stdout : null;
}

function contractEntriesAt(sha, cwd) {
  if (!SHA.test(sha)) return null;
  const tree = boundedGit(["ls-tree", "-r", "-z", sha], cwd);
  if (tree === null) return null;
  return tree.split("\0").filter((entry) => {
    const path = entry.slice(entry.indexOf("\t") + 1);
    // Retain the legacy NUL terminator in the digest as well as every entry.
    return isContractPath(path);
  }).sort();
}

export function verificationContractAt(sha, cwd = process.cwd(), { rendererDomShadow = false } = {}) {
  const entries = contractEntriesAt(sha, cwd);
  if (!entries?.length) return null;
  const contract = entries.map((entry) => rendererDomShadow && isRendererDomLeaf(entry)
    ? entry.replace(/ blob [0-9a-f]{40}\t/u, " blob <current-renderer-dom>\t") : entry);
  return createHash("sha256").update(contract.join("\0")).digest("hex");
}

export function contractDifference(base, head, cwd = process.cwd()) {
  const before = contractEntriesAt(base, cwd);
  const after = contractEntriesAt(head, cwd);
  if (!before || !after) return null;
  const byPath = (entries) => new Map(entries.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry]));
  const oldEntries = byPath(before);
  const newEntries = byPath(after);
  const changed = [...new Set([...oldEntries.keys(), ...newEntries.keys()])]
    .filter((path) => oldEntries.get(path) !== newEntries.get(path)).sort();
  return {
    count: changed.length,
    // Names only, never file contents or child-process diagnostics. Unusual
    // paths remain part of the digest but do not become workflow annotations.
    paths: changed.slice(0, MAX_DIAGNOSTICS).map((path) => /^[\w./-]{1,200}$/u.test(path) ? path : "<unusual-path>"),
    truncated: changed.length > MAX_DIAGNOSTICS,
  };
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
  differenceAt = () => null,
}) {
  const diagnostics = { evaluated: 0, rejected: {}, candidates: [], truncated: false };
  const result = (base, reason) => ({ base, reason, diagnostics });
  if (!Array.isArray(runs) || runs.length > MAX_BASELINES || !SHA.test(head)
    || !Number.isSafeInteger(workflowId) || workflowId < 1
    || !Number.isSafeInteger(currentRunId) || currentRunId < 1) {
    return result(null, "baseline-metadata-invalid");
  }
  const contract = contractAt(head);
  if (!contract) return result(null, "verification-contract-unavailable");
  // Only repository Actions metadata can nominate a baseline. A PR artifact,
  // latest-push delta, cancelled run, foreign branch, or future run cannot.
  for (const run of runs) {
    diagnostics.evaluated += 1;
    let rejection;
    if (!run || !Number.isSafeInteger(run.id) || run.id < 1 || run.id >= currentRunId
      || run.workflow_id !== workflowId || run.path !== ".github/workflows/ci.yml"
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
      || run.event !== "push" || run.head_branch !== "main"
      || run.status !== "completed" || run.conclusion !== "success"
      || !SHA.test(run.head_sha) || run.head_sha === head) rejection = "run-metadata";
    else if (!isAncestor(run.head_sha, head)) rejection = "not-ancestor-or-history-unavailable";
    else {
      const prior = contractAt(run.head_sha);
      if (!prior) rejection = "contract-unavailable";
      else if (prior !== contract) rejection = "contract-changed";
      else if (!await hasSuccessfulGate(run)) rejection = "merge-ready-evidence";
    }
    if (!rejection) return result(run.head_sha, `trusted-main-run:${run.id}`);
    diagnostics.rejected[rejection] = (diagnostics.rejected[rejection] ?? 0) + 1;
    if (diagnostics.candidates.length < MAX_DIAGNOSTICS) {
      diagnostics.candidates.push({
        runId: Number.isSafeInteger(run?.id) ? run.id : null,
        head: typeof run?.head_sha === "string" && SHA.test(run.head_sha) ? run.head_sha : null,
        rejection,
        ...(rejection === "contract-changed" ? { difference: differenceAt(run.head_sha, head) } : {}),
      });
    } else diagnostics.truncated = true;
  }
  return result(null, "no-successful-compatible-main-ancestor");
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

export async function resolveMainBaseline({ head, repository, runId, api = githubApi, cwd = process.cwd(), rendererDomShadow = false }) {
  const deadlineAt = Date.now() + 120_000;
  const remaining = () => {
    const milliseconds = deadlineAt - Date.now();
    if (milliseconds <= 0) throw metadataError("metadata-deadline");
    return milliseconds;
  };
  try {
    const current = api(`repos/${repository}/actions/runs/${runId}`, remaining());
    if (current.id !== runId || current.head_sha !== head
      || current.event !== "push" || current.head_branch !== "main"
      || current.repository?.full_name !== repository) throw metadataError("current-run-identity");
    const listing = api(`repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=50`, remaining());
    if (!Array.isArray(listing.workflow_runs)) throw metadataError("run-list-invalid");
    const contracts = new Map();
    const gates = new Map();
    const options = {
      runs: listing.workflow_runs, head, repository, workflowId: current.workflow_id,
      currentRunId: runId, contractAt: (sha) => {
        remaining();
        if (!contracts.has(sha)) contracts.set(sha, verificationContractAt(sha, cwd));
        return contracts.get(sha);
      },
      differenceAt: (base, candidate) => { remaining(); return contractDifference(base, candidate, cwd); },
      isAncestor: (base, candidate) => {
        remaining();
        return boundedGit(["merge-base", "--is-ancestor", base, candidate], cwd) !== null;
      },
      hasSuccessfulGate: async (run) => {
        if (gates.has(run.id)) return gates.get(run.id);
        remaining();
        const matches = currentRunJobs(repository, run.id, Math.min(deadlineAt, Date.now() + 30_000), api)
          .filter((job) => job.name === "merge-ready");
        const valid = matches.length === 1 && matches[0].run_id === run.id
          && matches[0].head_sha === run.head_sha && matches[0].status === "completed"
          && matches[0].conclusion === "success";
        gates.set(run.id, valid);
        return valid;
      },
    };
    const baseline = await selectMainBaseline(options);
    if (!rendererDomShadow) return baseline;
    // Observe a proposed policy without granting it any scheduling authority.
    // A failed optional observation must not replace valid strict evidence.
    try {
      baseline.shadow = await selectMainBaseline({ ...options,
        contractAt: (sha) => { remaining(); return verificationContractAt(sha, cwd, { rendererDomShadow: true }); },
      });
    } catch {
      baseline.shadow = { base: null, reason: "shadow-evidence-unavailable" };
    }
    return baseline;
  } catch (error) {
    // API limits, unavailable permissions, shallow/missing history, and every
    // ambiguous identity expand evidence. None creates a green baseline.
    return { base: null, reason: "trusted-main-baseline-unavailable",
      failureClass: ["metadata-deadline", "api-timeout", "api-command-failed", "api-json-invalid",
        "current-run-identity", "run-list-invalid"].includes(error?.code)
        ? error.code : "metadata-or-history-unavailable" };
  }
}
