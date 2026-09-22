import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { githubApi } from "./validation-baseline.mjs";

export function elapsedSeconds(start, end) {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const seconds = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// Deliberate allowlist: no logs, environment, step output, artifacts or secrets.
// A rerun may copy a successful job into a new record with old execution
// timestamps. Retain that evidence, but never count it as newly executed work.
export function summarizeAttempt(run, attempt, jobs) {
  if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(attempt) || attempt < 1
    || !/^[0-9a-f]{40}$/u.test(run.head_sha) || !Array.isArray(jobs)) {
    throw new Error("Invalid workflow timing identity.");
  }
  const ids = new Set();
  const records = jobs.map((job) => {
    if (!Number.isSafeInteger(job.id) || ids.has(job.id) || job.run_id !== run.id
      || job.run_attempt !== attempt || job.head_sha !== run.head_sha
      || typeof job.name !== "string" || job.name.length > 200
      || !Array.isArray(job.steps) || job.steps.length > 200) {
      throw new Error("Invalid job timing identity.");
    }
    ids.add(job.id);
    const queueSeconds = elapsedSeconds(job.created_at, job.started_at);
    const executionSeconds = elapsedSeconds(job.started_at, job.completed_at);
    const carriedForward = attempt > 1 && queueSeconds === null
      && elapsedSeconds(job.started_at, job.created_at) > 0;
    const active = job.conclusion !== "skipped" && !carriedForward;
    return {
      id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
      labels: Array.isArray(job.labels) ? job.labels.filter((label) => typeof label === "string" && label.length <= 100) : [],
      createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at,
      carriedForward, queueSeconds: active ? queueSeconds : null,
      executionSeconds: active ? executionSeconds : null,
      steps: job.steps.map((step) => ({
        number: step.number, name: step.name, status: step.status, conclusion: step.conclusion,
        seconds: active && step.conclusion !== "skipped"
          ? elapsedSeconds(step.started_at, step.completed_at) : null,
      })),
    };
  });
  return {
    runId: run.id, sourceHead: run.head_sha, event: run.event, attempt,
    // The listing's conclusion describes the latest attempt, not older ones.
    latestRunConclusion: run.conclusion,
    recordedExecutionSeconds: records.reduce((sum, job) => sum + (job.executionSeconds ?? 0), 0),
    unknownExecutionCount: records.filter((job) => job.conclusion !== "skipped"
      && !job.carriedForward && job.executionSeconds === null).length,
    jobs: records,
  };
}

export async function collectWorkflowTimings({ repository, limit = 10, api = githubApi }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)
    || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid timing collection scope.");
  const listing = await api(`repos/${repository}/actions/workflows/ci.yml/runs?status=completed&per_page=${limit}`);
  if (!Array.isArray(listing?.workflow_runs) || listing.workflow_runs.length > limit) {
    throw new Error("Malformed workflow timing listing.");
  }
  const attempts = [];
  for (const run of listing.workflow_runs) {
    if (!Number.isSafeInteger(run.id) || run.id < 1 || run.path !== ".github/workflows/ci.yml"
      || run.repository?.full_name !== repository || run.status !== "completed"
      || !Number.isInteger(run.run_attempt) || run.run_attempt < 1 || run.run_attempt > 10) {
      throw new Error("Invalid or excessive workflow timing history.");
    }
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      const jobs = [];
      let total;
      for (let page = 1; page <= 3; page += 1) {
        const result = await api(`repos/${repository}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100&page=${page}`);
        if (!Array.isArray(result?.jobs) || !Number.isInteger(result.total_count)
          || result.total_count < 0 || result.total_count > 300
          || (total !== undefined && total !== result.total_count)) throw new Error("Malformed timing pagination.");
        total = result.total_count;
        jobs.push(...result.jobs);
        if (jobs.length === total) break;
        if (jobs.length > total || result.jobs.length !== 100) throw new Error("Truncated timing pagination.");
      }
      if (jobs.length !== total) throw new Error("Incomplete timing history.");
      attempts.push(summarizeAttempt(run, attempt, jobs));
    }
  }
  return {
    schemaVersion: 1, repository, collectedAt: new Date().toISOString(),
    scope: "Latest completed CI runs, all bounded attempts; failures and cancellations retained.",
    limitations: ["Runner labels are not exact image versions.", "Cache hit/miss is unavailable from REST step metadata.",
      "PR source heads are not tested merge SHAs; correlate the exact candidate and lane with the plan and Electron reports.",
      "Recorded execution excludes skipped, carried-forward and unavailable timing intervals.",
      "Queue intervals include admission delays; account-wide capacity is not inferred."],
    attempts,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, output, limit = "10", ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error("Usage: node scripts/ci/collect-workflow-timings.mjs OWNER/REPO OUTPUT.json [1..50]");
  await writeFile(output, `${JSON.stringify(await collectWorkflowTimings({ repository, limit: Number(limit) }), null, 2)}\n`);
}
