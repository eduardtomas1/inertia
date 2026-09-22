import { expect, it, vi } from "vitest";
import { collectWorkflowTimings, elapsedSeconds, summarizeAttempt } from "../../scripts/ci/collect-workflow-timings.mjs";

const start = "2026-09-20T10:00:00Z";
const end = "2026-09-20T10:01:00Z";
const run = { id: 20, head_sha: "a".repeat(40), event: "push", conclusion: "success",
  status: "completed", path: ".github/workflows/ci.yml", repository: { full_name: "test/ci" }, run_attempt: 2 };
const job = { id: 100, run_id: 20, run_attempt: 1, head_sha: run.head_sha,
  name: "macOS x64", status: "completed", conclusion: "failure", labels: ["macos-15-intel"],
  created_at: start, started_at: start, completed_at: end,
  steps: [{ number: 1, name: "units", status: "completed", conclusion: "failure", started_at: start, completed_at: end }],
};

it("does not fabricate zero/negative time from unavailable or malformed timestamps", () => {
  expect(elapsedSeconds(start, end)).toBe(60);
  expect(elapsedSeconds(start, start)).toBe(0);
  for (const pair of [[end, start], [null, end], [start, "invalid"], [undefined, undefined]]) {
    expect(elapsedSeconds(...pair as [unknown, unknown])).toBeNull();
  }
});

it("retains first failures and cancelled attempts without double counting carried-forward jobs", async () => {
  const api = vi.fn((endpoint: string) => endpoint.includes("workflows/") ? { workflow_runs: [run] }
    : { total_count: 1, jobs: [endpoint.includes("attempts/1/") ? job
      : { ...job, id: 101, run_attempt: 2, conclusion: "success", created_at: end }] });
  const report = await collectWorkflowTimings({ repository: "test/ci", api });
  expect(report.attempts.map((a) => a.recordedExecutionSeconds)).toEqual([60, 0]);
  expect(report.attempts[1]!.jobs[0]).toMatchObject({ carriedForward: true, queueSeconds: null, executionSeconds: null });
  expect(report.attempts[1]!.jobs[0]!.steps[0]!.seconds).toBeNull();
  expect(JSON.stringify(report)).toContain('"conclusion":"failure"');
  expect(summarizeAttempt(run, 1, [{ ...job, conclusion: "cancelled" }]).recordedExecutionSeconds).toBe(60);
  expect(summarizeAttempt(run, 1, [{ ...job, conclusion: "skipped" }]).recordedExecutionSeconds).toBe(0);
});

it("rejects incomplete pagination, ambiguous job identities and excessive attempt history", async () => {
  for (const bad of [{ ...job, run_id: 21 }, { ...job, run_attempt: 2 }, { ...job, head_sha: "b".repeat(40) }]) {
    expect(() => summarizeAttempt(run, 1, [bad])).toThrow();
  }
  expect(() => summarizeAttempt(run, 1, [job, job])).toThrow();
  const api = (endpoint: string) => endpoint.includes("workflows/") ? { workflow_runs: [run] } : { total_count: 2, jobs: [job] };
  await expect(collectWorkflowTimings({ repository: "test/ci", api })).rejects.toThrow("Truncated");
  await expect(collectWorkflowTimings({ repository: "test/ci", api: () => ({ workflow_runs: [{ ...run, run_attempt: 11 }] }) }))
    .rejects.toThrow("excessive");
});

it("records admission separately and excludes unexpected payloads", () => {
  const report = summarizeAttempt(run, 1, [{ ...job, created_at: "2026-09-20T09:50:00Z",
    environment: "secret", logs: "secret", steps: [{ ...job.steps[0], output: "secret" }] }]);
  expect(report.jobs[0]!.queueSeconds).toBe(600);
  expect(report.recordedExecutionSeconds).toBe(60);
  expect(JSON.stringify(report)).not.toContain("secret");
});
