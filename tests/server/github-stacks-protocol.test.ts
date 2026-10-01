// @inertia-test-suite portable
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createGitHubRequest, decodeGitHubResponse, GitHubResponseError, type GitHubRequest } from "../../src/server/pull-requests/github-transport";
import { GitHubPullRequestsClient } from "../../src/server/pull-requests/github-client";
import { decodePr, decodeStack, snapshotForPr } from "../../src/server/pull-requests/github-schemas";
import { prKey, prSha } from "../support/pull-request-fixtures";
function response() {
  return { data: { repository: { pullRequest: {
    id: "PR_42", number: 42, title: "Related work", state: "OPEN", isDraft: false,
    headRefName: "topic", headRefOid: prSha(42), baseRefName: "main", baseRefOid: prSha(40), additions: 13, deletions: 2,
    updatedAt: "2026-10-01T12:00:00Z", author: { login: "example" }, mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", maintainerCanModify: false,
    headRepository: { viewerPermission: "WRITE" }, repository: { nameWithOwner: "acme/workspace", viewerPermission: "WRITE" },
    commits: { nodes: [{ commit: { oid: prSha(42), statusCheckRollup: { contexts: { totalCount: 3, pageInfo: { hasNextPage: false }, nodes: [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "PENDING" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
    ] } } } }] }, reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ isResolved: false }] },
  } } } };
}
const rawStack = () => [{ node_id: "ST_43", number: 43, base: { ref: "main" }, pull_requests: [
  { number: 41, head: { ref: "bottom", sha: prSha(41) }, state: "closed", merged_at: "2026-10-01T10:00:00Z", draft: false },
  { number: 42, head: { ref: "top", sha: prSha(42) }, state: "open", merged_at: null, draft: false },
] }];

describe("native GitHub stack protocol", () => {
  it("reads complete checks and review-thread evidence for the exact repository, PR and head", () => {
    const pr = decodePr(response(), prKey());
    expect(snapshotForPr(pr, "2026-10-01T12:01:00Z")).toMatchObject({
      checks: { total: 3, passed: 1, pending: 1, failed: 1, complete: true }, unresolvedReviews: 1, reviewsComplete: true, canUpdateBranch: true,
    });
    const mismatch = response(); mismatch.data.repository.pullRequest.repository.nameWithOwner = "other/repo";
    expect(() => decodePr(mismatch, prKey())).toThrow("different pull request");
  });
  it("does not treat truncated or non-head checks as complete evidence", () => {
    const value = response(); value.data.repository.pullRequest.commits.nodes[0]!.commit.oid = prSha(9);
    value.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage = true;
    const snapshot = snapshotForPr(decodePr(value, prKey()), "2026-10-01T12:01:00Z");
    expect(snapshot.checks.complete).toBe(false); expect(snapshot.reviewsComplete).toBe(false);
  });
  it("requires base repository write access before using fork maintainer permission", () => {
    const value = response(); const pr = value.data.repository.pullRequest;
    pr.headRepository.viewerPermission = "READ"; pr.maintainerCanModify = true; pr.repository.viewerPermission = "READ";
    expect(snapshotForPr(decodePr(value, prKey()), "2026-10-01T12:01:00Z").canUpdateBranch).toBe(false);
    pr.repository.viewerPermission = "WRITE";
    expect(snapshotForPr(decodePr(value, prKey()), "2026-10-01T12:01:00Z").canUpdateBranch).toBe(true);
  });
  it("refuses partial GraphQL errors, malformed data and duplicate or unrelated stack layers", () => {
    expect(() => decodePr({ ...response(), errors: [{ message: "private error" }] }, prKey())).toThrow("complete pull request");
    expect(() => decodePr({ data: { repository: null } }, prKey())).toThrow("complete pull request");
    const duplicate = rawStack(); duplicate[0]!.pull_requests.push(duplicate[0]!.pull_requests[1]!);
    expect(() => decodeStack(duplicate, prKey())).toThrow();
    expect(() => decodeStack(rawStack(), prKey(99))).toThrow("different pull request");
    expect(decodeStack(rawStack(), prKey())?.layers.map((layer) => layer.state)).toEqual(["merged", "open"]);
  });
  it("treats only a native stack 404 as unavailable", async () => {
    const request = vi.fn<GitHubRequest>().mockRejectedValue(new GitHubResponseError(404));
    const client = new GitHubPullRequestsClient(request);
    await expect(client.stack(prKey())).resolves.toBeNull();
    request.mockRejectedValueOnce(new GitHubResponseError(403));
    await expect(client.stack(prKey())).rejects.toThrow("access was refused");
  });
  it("uses the native merge endpoint, reviewed SHA and opaque polling receipt", async () => {
    const request = vi.fn<GitHubRequest>().mockResolvedValue({ status: "pending", details: { uuid: "receipt_1" } });
    const client = new GitHubPullRequestsClient(request);
    await client.merge(prKey(), prSha(42));
    expect(request).toHaveBeenCalledWith("PUT", "repos/acme/workspace/pulls/42/merge-async", { merge_method: "merge", merge_action: "default", sha: prSha(42) });
    await client.mergeStatus(prKey(), "receipt_1");
    expect(request).toHaveBeenLastCalledWith("GET", "repos/acme/workspace/pulls/42/merge-async/receipt_1");
    await expect(client.mergeStatus(prKey(), "../other")).rejects.toThrow("invalid");
  });
  it("checks prior heads and binds each rebase mutation to the observed revision", async () => {
    const read = { data: { processed: [{ headRefOid: prSha(141) }], repository: { pullRequest: { id: "PR_42", headRefOid: prSha(42), baseRef: { target: { oid: prSha(141) }, compare: { behindBy: 1 } } } } } };
    const request = vi.fn<GitHubRequest>().mockResolvedValue(read);
    const client = new GitHubPullRequestsClient(request);
    const prior = [{ id: "PR_41", number: 41, head: prSha(141) }];
    await expect(client.branch(prKey(), prSha(42), prior)).resolves.toMatchObject({ head: prSha(42), base: prSha(141), behind: 1 });
    read.data.processed[0]!.headRefOid = prSha(777);
    await expect(client.branch(prKey(), prSha(42), prior)).rejects.toThrow("earlier stack layer changed");
    request.mockResolvedValue({ data: { updatePullRequestBranch: { pullRequest: { headRefOid: prSha(142) } } } });
    await expect(client.rebase("PR_42", prSha(42))).resolves.toBe(prSha(142));
    const body = request.mock.calls.at(-1)![2]!;
    expect(body.variables).toEqual({ id: "PR_42", sha: prSha(42) });
    expect(body.query).toContain("expectedHeadOid:$sha,updateMethod:REBASE");
  });
  it("validates HTTP status and complete JSON even when gh exits unsuccessfully", () => {
    expect(decodeGitHubResponse('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}\n', 0)).toEqual({ ok: true });
    expect(() => decodeGitHubResponse('HTTP/2.0 404 Not Found\nContent-Type: application/json\n\n{"message":"private"}', 1)).toThrow(GitHubResponseError);
    expect(() => decodeGitHubResponse('HTTP/2.0 200 OK\n\n{"data":null}', 1)).toThrow("did not confirm");
    expect(() => decodeGitHubResponse('HTTP/2.0 200 OK\n\n{', 0)).toThrow("invalid JSON");
    expect(() => decodeGitHubResponse('garbage', 0)).toThrow("unreadable response");
  });
  it("launches a bounded shell-free CLI with fixed host and JSON stdin, stripping ambient credentials", async () => {
    const stdin: string[] = [];
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      child.stdin.on("data", (data: Buffer) => stdin.push(data.toString()));
      queueMicrotask(() => { child.stdout.emit("data", Buffer.from('HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"ok":true}')); child.emit("close", 0); });
      return child;
    });
    const request = createGitHubRequest("/owned-data", new AbortController().signal, { platform: "linux", spawn,
      environment: async () => ({ env: { HOME: "/fake", GH_TOKEN: "must-not-cross", GH_HOST: "evil.test", PATH: "/bin" }, pathEntries: ["/bin"] }),
      executableCandidates: async () => ["/bin/gh"] });
    await expect(request("POST", "graphql", { query: "query { viewer { login } }" })).resolves.toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledWith("/bin/gh", ["api", "--hostname", "github.com", "--include", "--method", "POST", "graphql", "--input", "-"], expect.objectContaining({ cwd: "/owned-data", shell: false, env: { NO_COLOR: "1", HOME: "/fake", PATH: "/bin" } }));
    expect(JSON.parse(stdin.join(""))).toEqual({ query: "query { viewer { login } }" });
    await expect(request("GET", "https://evil.test/repos/acme/workspace")).rejects.toThrow("endpoint is invalid");
    expect(spawn).toHaveBeenCalledOnce();
  });
});
