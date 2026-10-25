export const PREVIOUS_NIGHTLY_TIMEOUT_MS = 15_000;
const TITLE = "Nightly certification failed";
const MARKER = "<!-- inertia-nightly-lifecycle-certification -->";
const CONCLUSION = /^[a-z_]{1,32}$/u;

function runUrl(context) {
  return `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
}

async function trackedIssue(github, context) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo,
    state: "all",
    per_page: 100,
  });
  return issues.find((issue) =>
    !issue.pull_request && issue.user?.login === "github-actions[bot]" && issue.body?.includes(MARKER)
  );
}

export async function previousNightlyConclusion({
  github, context, workflowId, timeoutMs = PREVIOUS_NIGHTLY_TIMEOUT_MS,
}) {
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      github.rest.actions.listWorkflowRuns({
        ...context.repo,
        workflow_id: workflowId,
        event: "schedule",
        status: "completed",
        per_page: 20,
        request: { signal: controller.signal },
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The previous nightly lookup timed out.")), timeoutMs);
      }),
    ]);
    const runs = Array.isArray(response?.data?.workflow_runs) ? response.data.workflow_runs : [];
    const previous = runs
      .filter((run) => Number.isSafeInteger(run?.run_number)
        && run.run_number < context.runNumber && run.id !== context.runId)
      .reduce((latest, run) => (latest === null || run.run_number > latest.run_number ? run : latest), null);
    return typeof previous?.conclusion === "string" && CONCLUSION.test(previous.conclusion)
      ? previous.conclusion
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function reportGreenNightly({ github, context, workflowId, timeoutMs }) {
  const existing = await trackedIssue(github, context);
  if (existing?.state !== "open") return "none";
  const previous = await previousNightlyConclusion({ github, context, workflowId, timeoutMs });
  const close = previous === "success";
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: existing.number,
    body: [
      "The scheduled six-target nightly certification passed.",
      "",
      `- Exact SHA: \`${context.sha}\``,
      `- [Runner logs and retained artifacts](${runUrl(context)})`,
      "",
      close
        ? "The previous scheduled nightly also passed, so this issue is closed."
        : previous === null
          ? "The previous scheduled nightly could not be read, so this issue stays open."
          : `The previous scheduled nightly concluded \`${previous}\`, so this issue stays open until two consecutive nightlies pass.`,
    ].join("\n"),
  });
  if (!close) return "commented";
  await github.rest.issues.update({
    ...context.repo,
    issue_number: existing.number,
    state: "closed",
    state_reason: "completed",
  });
  return "closed";
}

async function reportFailedNightly({ github, context }) {
  const jobs = await github.paginate(
    github.rest.actions.listJobsForWorkflowRun,
    { ...context.repo, run_id: context.runId, filter: "latest", per_page: 100 },
  );
  const failed = jobs.filter((job) =>
    ["failure", "cancelled", "timed_out", "action_required"].includes(job.conclusion)
  );
  const failureEvidence = failed.flatMap((job) => {
    const steps = (job.steps || [])
      .filter((step) => ["failure", "cancelled", "timed_out"].includes(step.conclusion))
      .map((step) => `${job.name}: ${step.name}`);
    return steps.length > 0 ? steps : [`${job.name}: ${job.conclusion}`];
  });
  const existing = await trackedIssue(github, context);
  const priorComments = existing
    ? await github.paginate(github.rest.issues.listComments, {
        ...context.repo,
        issue_number: existing.number,
        per_page: 100,
      })
    : [];
  const priorOccurrences = existing
    ? 1 + priorComments.filter((comment) => comment.body?.includes(MARKER)).length
    : 0;
  const manifestUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/blob/${context.sha}/package.json`;
  const body = [
    MARKER,
    "The scheduled six-target nightly certification did not complete cleanly.",
    "",
    `- Exact SHA: \`${context.sha}\``,
    `- Prior occurrences tracked here: ${priorOccurrences}`,
    `- [Runner logs and retained artifacts](${runUrl(context)})`,
    `- [Provider dependency versions bound to this SHA](${manifestUrl})`,
    "",
    "### Failing invariant / platform evidence",
    ...(failureEvidence.length > 0
      ? failureEvidence.map((value) => `- ${value}`)
      : ["- The workflow stopped before bounded job evidence was available."]),
    "",
    "Provider/version is only applicable when named by a failed provider step; exact",
    "locked versions remain bound to the linked SHA. This issue contains no runner",
    "output, prompts, paths, provider payloads, environment values, or credentials.",
  ].join("\n");
  if (!existing) {
    await github.rest.issues.create({ ...context.repo, title: TITLE, body });
    return "created";
  }
  const reopened = existing.state !== "open";
  if (reopened) {
    await github.rest.issues.update({
      ...context.repo,
      issue_number: existing.number,
      state: "open",
    });
  }
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: existing.number,
    body,
  });
  return reopened ? "reopened" : "commented";
}

export async function reportNightly({
  github, context, mergeReadyResult, workflowId, timeoutMs = PREVIOUS_NIGHTLY_TIMEOUT_MS,
}) {
  return mergeReadyResult === "success"
    ? reportGreenNightly({ github, context, workflowId, timeoutMs })
    : reportFailedNightly({ github, context });
}
