import { expect, it, vi } from "vitest";
import {
  previousNightlyConclusion,
  reportNightly,
  type NightlyReportContext,
  type NightlyReportGitHub,
} from "../../scripts/ci/nightly-report.mjs";

const MARKER = "<!-- inertia-nightly-lifecycle-certification -->";
const context: NightlyReportContext = {
  repo: { owner: "eduardtomas1", repo: "inertia" },
  runId: 900,
  runNumber: 50,
  sha: "a".repeat(40),
  serverUrl: "https://github.com",
};

type Run = { id: number; run_number: number; conclusion: string | null };

function fakeGitHub({
  issueState = "open",
  runs = [] as Run[],
  listWorkflowRuns,
  jobs = [] as unknown[],
}: {
  issueState?: "open" | "closed" | null;
  runs?: Run[];
  listWorkflowRuns?: (parameters: Record<string, unknown>) => Promise<unknown>;
  jobs?: unknown[];
} = {}) {
  const issue = issueState === null ? null
    : { number: 272, state: issueState, user: { login: "github-actions[bot]" }, body: `${MARKER}\nfailed` };
  const rest = {
    actions: {
      listJobsForWorkflowRun: vi.fn(async () => ({ data: { jobs } })),
      listWorkflowRuns: vi.fn(listWorkflowRuns ?? (async () => ({ data: { workflow_runs: runs } }))),
    },
    issues: {
      listForRepo: vi.fn(async () => ({ data: [] })),
      listComments: vi.fn(async () => ({ data: [] })),
      create: vi.fn(async () => ({ data: {} })),
      createComment: vi.fn(async () => ({ data: {} })),
      update: vi.fn(async () => ({ data: {} })),
    },
  };
  const paginate = vi.fn(async (method: unknown) => {
    if (method === rest.issues.listForRepo) {
      return [{ number: 1, state: "open", user: { login: "someone" }, body: MARKER }, ...(issue ? [issue] : [])];
    }
    if (method === rest.actions.listJobsForWorkflowRun) return jobs;
    return [];
  });
  const github: NightlyReportGitHub = { paginate, rest };
  return { github, rest };
}

function commentBody(rest: ReturnType<typeof fakeGitHub>["rest"]): string {
  const [parameters] = rest.issues.createComment.mock.calls[0] as unknown as [{ body: string }];
  return parameters.body;
}

it("closes the tracked issue only when the previous scheduled nightly also passed", async () => {
  const { github, rest } = fakeGitHub({ runs: [
    { id: 880, run_number: 48, conclusion: "failure" },
    { id: 890, run_number: 49, conclusion: "success" },
  ] });
  expect(await reportNightly({ github, context, mergeReadyResult: "success", workflowId: "ci.yml" }))
    .toBe("closed");
  expect(rest.actions.listWorkflowRuns).toHaveBeenCalledWith(expect.objectContaining({
    owner: "eduardtomas1", repo: "inertia", workflow_id: "ci.yml",
    event: "schedule", status: "completed", per_page: 20,
  }));
  expect(commentBody(rest)).toContain("previous scheduled nightly also passed");
  expect(rest.issues.update).toHaveBeenCalledWith(expect.objectContaining({
    issue_number: 272, state: "closed", state_reason: "completed",
  }));
});

it("only comments on a single green night after a failed nightly", async () => {
  const { github, rest } = fakeGitHub({ runs: [
    { id: 890, run_number: 49, conclusion: "failure" },
    { id: 880, run_number: 48, conclusion: "success" },
  ] });
  expect(await reportNightly({ github, context, mergeReadyResult: "success", workflowId: "ci.yml" }))
    .toBe("commented");
  expect(commentBody(rest)).toContain("concluded `failure`, so this issue stays open until two consecutive nightlies pass");
  expect(rest.issues.update).not.toHaveBeenCalled();
});

it("ignores the current and later runs when choosing the previous nightly", async () => {
  const { github } = fakeGitHub({ runs: [
    { id: 900, run_number: 50, conclusion: "success" },
    { id: 910, run_number: 51, conclusion: "success" },
    { id: 870, run_number: 47, conclusion: "success" },
    { id: 885, run_number: 48, conclusion: "cancelled" },
  ] });
  expect(await previousNightlyConclusion({ github, context, workflowId: "ci.yml" })).toBe("cancelled");
});

it.each([
  ["the lookup fails", async () => { throw new Error("HTTP 502"); }],
  ["no earlier nightly is listed", async () => ({ data: { workflow_runs: [] } })],
  ["the response is malformed", async () => ({ data: { workflow_runs: "unexpected" } })],
  ["the conclusion is not a GitHub conclusion", async () => ({
    data: { workflow_runs: [{ id: 890, run_number: 49, conclusion: "success\n- injected" }] },
  })],
])("fails open to a comment when %s", async (_label, listWorkflowRuns) => {
  const { github, rest } = fakeGitHub({ listWorkflowRuns });
  expect(await reportNightly({ github, context, mergeReadyResult: "success", workflowId: "ci.yml" }))
    .toBe("commented");
  expect(commentBody(rest)).toContain("previous scheduled nightly could not be read");
  expect(rest.issues.update).not.toHaveBeenCalled();
});

it("bounds the previous nightly lookup and aborts the request on timeout", async () => {
  let signal: AbortSignal | undefined;
  const { github, rest } = fakeGitHub({
    listWorkflowRuns: (parameters) => {
      signal = (parameters.request as { signal: AbortSignal }).signal;
      return new Promise(() => {});
    },
  });
  expect(await reportNightly({
    github, context, mergeReadyResult: "success", workflowId: "ci.yml", timeoutMs: 5,
  })).toBe("commented");
  expect(signal?.aborted).toBe(true);
  expect(rest.issues.update).not.toHaveBeenCalled();
});

it.each([["closed" as const], [null]])("does nothing on a green night when the tracked issue is %s", async (issueState) => {
  const { github, rest } = fakeGitHub({ issueState, runs: [{ id: 890, run_number: 49, conclusion: "success" }] });
  expect(await reportNightly({ github, context, mergeReadyResult: "success", workflowId: "ci.yml" }))
    .toBe("none");
  expect(rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
  expect(rest.issues.createComment).not.toHaveBeenCalled();
  expect(rest.issues.update).not.toHaveBeenCalled();
});

it("reopens and comments on the tracked issue when the nightly fails", async () => {
  const { github, rest } = fakeGitHub({
    issueState: "closed",
    jobs: [{ name: "macOS x64 unit tests (1/2)", conclusion: "failure",
      steps: [{ name: "Run macOS x64 unit-test shard", conclusion: "failure" }] }],
  });
  expect(await reportNightly({ github, context, mergeReadyResult: "failure", workflowId: "ci.yml" }))
    .toBe("reopened");
  expect(rest.issues.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 272, state: "open" }));
  expect(commentBody(rest)).toContain("- macOS x64 unit tests (1/2): Run macOS x64 unit-test shard");
  expect(rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
});

it("opens the tracked issue on the first failed nightly", async () => {
  const { github, rest } = fakeGitHub({ issueState: null });
  expect(await reportNightly({ github, context, mergeReadyResult: "cancelled", workflowId: "ci.yml" }))
    .toBe("created");
  expect(rest.issues.create).toHaveBeenCalledWith(expect.objectContaining({ title: "Nightly certification failed" }));
});
