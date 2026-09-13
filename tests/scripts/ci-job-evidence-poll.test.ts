import { expect, it, vi } from "vitest";
import { settledJobEvidence, type JobEvidence } from "../../scripts/ci/settled-job-evidence.mjs";

const complete: JobEvidence = { name: "Linux interaction and lifecycle", run_id: 42,
  head_sha: "a".repeat(40), status: "completed", conclusion: "success" };
function options(snapshots: JobEvidence[][]) {
  let time = 0;
  const readJobs = vi.fn(() => snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!);
  const wait = vi.fn(async (milliseconds: number) => { time += milliseconds; });
  return { requiredChecks: [complete.name], runId: 42, sourceHead: complete.head_sha,
    readJobs, wait, now: () => time };
}

it("waits for a missing or still-running REST record after dependency completion", async () => {
  const context = options([[], [{ ...complete, status: "in_progress", conclusion: null }], [complete]]);
  expect(await settledJobEvidence(context)).toEqual([complete]);
  expect(context.readJobs).toHaveBeenCalledTimes(3);
  expect(context.wait).toHaveBeenCalledTimes(2);
});

it.each([
  [{ ...complete, conclusion: "failure" }],
  [{ ...complete, conclusion: "cancelled" }],
  [{ ...complete, run_id: 41 }],
  [{ ...complete, head_sha: "b".repeat(40) }],
  [complete, complete],
].map((jobs) => [jobs]))("preserves terminal or mismatched evidence without waiting for replacement", async (jobs) => {
  const context = options([jobs, [complete]]);
  expect(await settledJobEvidence(context)).toEqual(jobs);
  expect(context.readJobs).toHaveBeenCalledTimes(1);
  expect(context.wait).not.toHaveBeenCalled();
});

it("stops polling missing evidence within its attempt and time bounds", async () => {
  const context = options([[]]);
  expect(await settledJobEvidence(context)).toEqual([]);
  expect(context.readJobs).toHaveBeenCalledTimes(16);
  expect(context.now()).toBeLessThanOrEqual(45_000);
});

it("does not replace failed evidence while another required check is missing", async () => {
  const failed = { ...complete, conclusion: "failure" };
  const context = options([[failed], [complete, { ...complete, name: "Other" }]]);
  context.requiredChecks.unshift("Other");
  expect(await settledJobEvidence(context)).toEqual([failed]);
  expect(context.wait).not.toHaveBeenCalled();
});

it("keeps API failures closed", async () => {
  const context = options([[]]);
  context.readJobs.mockImplementation(() => { throw new Error("metadata unavailable"); });
  await expect(settledJobEvidence(context)).rejects.toThrow("metadata unavailable");
  expect(context.wait).not.toHaveBeenCalled();
});
