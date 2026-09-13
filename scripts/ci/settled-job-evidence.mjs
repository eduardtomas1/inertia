/** Wait only for REST propagation after the workflow's required jobs succeed. */
export async function settledJobEvidence({ requiredChecks, runId, sourceHead, readJobs, wait, now = Date.now }) {
  const deadlineAt = now() + 45_000;
  let jobs = [];
  for (let attempt = 0; attempt < 16; attempt += 1) {
    jobs = readJobs(deadlineAt);
    let pending = false;
    for (const name of requiredChecks) {
      const matches = jobs.filter((job) => job.name === name);
      if (matches.length === 0) { pending = true; continue; }
      // Duplicate, foreign, failed or cancelled evidence remains a failure;
      // do not mask it by polling until a different record replaces it.
      if (matches.length !== 1) return jobs;
      const job = matches[0];
      if (job.run_id !== runId || job.head_sha !== sourceHead) return jobs;
      if (job.status === "completed" && job.conclusion === "success") continue;
      if (job.conclusion !== null
        || !["queued", "waiting", "in_progress", "completed"].includes(job.status)) return jobs;
      pending = true;
    }
    if (!pending || attempt === 15 || now() >= deadlineAt - 2_000) return jobs;
    await wait(2_000);
  }
  return jobs;
}
