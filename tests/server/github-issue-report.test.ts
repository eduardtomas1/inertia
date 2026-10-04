import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyGitHubCliFailure, githubIssuePublisher, IssuePublicationError } from "../../src/server/git/github-issue-report";
import { RestrictedCliError } from "../../src/server/restricted-cli-runner";
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/server/restricted-cli-runner", async (original) => ({ ...await original<object>(), runRestrictedCli: mocks.run }));
afterEach(() => { vi.useRealTimers(); mocks.run.mockReset(); });
const id = "11111111-1111-4111-8111-111111111111";
const dependencies = { environment: async () => ({ env: {}, pathEntries: [] }), executableCandidates: async () => ["/fake/gh"] };
describe("fixed-repository issue publisher", () => {
  it("authenticates before marking publication attempted and passes the exact preview only through bounded stdin", async () => {
    const beforePublish = vi.fn();
    mocks.run.mockImplementation(async (_executable, args) => {
      if (args[0] === "auth") { expect(beforePublish).not.toHaveBeenCalled(); return { stdout: "", stderr: "" }; }
      expect(beforePublish).toHaveBeenCalledOnce();
      return { stdout: "https://github.com/eduardtomas1/inertia/issues/123\n", stderr: "" };
    });
    const publisher = githubIssuePublisher("/private/app-owned", new AbortController().signal, dependencies);
    await expect(publisher.create({ id, title: "A bug report", body: "Public reviewed text", beforePublish })).resolves.toContain("/inertia/issues/123");
    expect(mocks.run.mock.calls[1]).toEqual(["/fake/gh", ["issue", "create", "--repo", "eduardtomas1/inertia", "--title", "A bug report", "--body-file", "-"], expect.objectContaining({ input: `Public reviewed text\n\n<!-- inertia-report:${id} -->`, maxOutputBytes: 16384, timeoutMs: 25000, signal: expect.any(AbortSignal) }), dependencies]);
  });
  it("bounds stalled discovery and never marks a failed auth check as publication", async () => {
    vi.useFakeTimers();
    const beforePublish = vi.fn();
    const publisher = githubIssuePublisher("/private/app-owned", new AbortController().signal, { ...dependencies, environment: () => new Promise(() => undefined) });
    // Use runtime lifetime cancellation too: AbortSignal.timeout uses the native clock.
    const lifetime = new AbortController();
    const cancellable = githubIssuePublisher("/private/app-owned", lifetime.signal, { ...dependencies, environment: () => new Promise(() => undefined) });
    const operation = cancellable.create({ id, title: "A bug", body: "A useful report", beforePublish });
    lifetime.abort();
    await expect(operation).rejects.toThrow("cancelled");
    expect(beforePublish).not.toHaveBeenCalled();
    expect(publisher).toBeDefined();
    mocks.run.mockRejectedValueOnce(new Error("auth failed"));
    await expect(githubIssuePublisher("/app", new AbortController().signal, dependencies).create({ id, title: "A bug", body: "Useful report", beforePublish })).rejects.toThrow();
    expect(beforePublish).not.toHaveBeenCalled();
  });
  it("matches the exact report marker and rejects hostile results during read-only reconciliation", async () => {
    mocks.run.mockResolvedValueOnce({ stdout: "https://github.com/attacker/repo/issues/1\nhttps://github.com/eduardtomas1/inertia/issues/123\n", stderr: "" });
    const publisher = githubIssuePublisher("/app", new AbortController().signal, dependencies);
    await expect(publisher.find(id)).resolves.toContain("/inertia/issues/123");
    expect(mocks.run.mock.calls[0]![1]).toEqual(["issue", "list", "--repo", "eduardtomas1/inertia", "--state", "all", "--search", `in:body "inertia-report:${id}"`, "--limit", "10", "--json", "url,body", "--jq", `.[] | select(.body | contains("<!-- inertia-report:${id} -->")) | .url`]);
  });
});


it("reconciles a 19,000-character published body without overflowing the 16 KiB output boundary", async () => {
  const record = { body: "x".repeat(19_000) + `<!-- inertia-report:${id} -->`, url: "https://github.com/eduardtomas1/inertia/issues/123" };
  mocks.run.mockImplementation(async (_executable, args, options) => {
    const stdout = args.includes("--jq") ? record.url : JSON.stringify([record]);
    if (Buffer.byteLength(stdout) > options.maxOutputBytes) throw new Error("output-limit");
    return { stdout, stderr: "" };
  });
  const publisher = githubIssuePublisher("/app", new AbortController().signal, dependencies);
  await expect(publisher.find(id)).resolves.toBe(record.url);
  expect(mocks.run).toHaveBeenCalledOnce();
});


it.each([
  ["You are not logged into any GitHub hosts. To log in, run: gh auth login", "signed-out"],
  ["HTTP 401: Bad credentials (https://api.github.com/graphql)", "signed-out"],
  ["github.com\n  X Failed to log in to github.com account octocat (keyring)\n  - The token in keyring is invalid.", "signed-out"],
  ["error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com", "offline"],
  ["Post \"https://api.github.com/graphql\": dial tcp: lookup api.github.com: no such host", "offline"],
  ["X Timeout trying to log in to github.com account octocat (keyring)", "offline"],
  ["GraphQL: API rate limit exceeded for user ID 1.", "rate-limited"],
  ["You have exceeded a secondary rate limit. Please wait a few minutes before you try again.", "rate-limited"],
  ["HTTP 429: Too Many Requests", "rate-limited"],
  ["GraphQL: Could not resolve to a Repository with the name 'eduardtomas1/inertia'. (repository)", "repository"],
  ["the 'eduardtomas1/inertia' repository has disabled issues", "repository"],
  ["HTTP 404: Not Found (https://api.github.com/repos/eduardtomas1/inertia)", "repository"],
  ["something unexpected happened", null],
])("classifies GitHub CLI stderr %#", (stderr, reason) => {
  expect(classifyGitHubCliFailure(stderr)).toBe(reason);
});

function failWith(stderr: string) {
  return async (_executable: string, _args: string[], options: { failureMessage: string; classifyFailure?(stderr: string): string | null }) => {
    throw new RestrictedCliError("failed", options.failureMessage, undefined, options.classifyFailure?.(stderr) ?? null);
  };
}

it("reports a signed-out GitHub CLI before publication is attempted", async () => {
  const beforePublish = vi.fn();
  mocks.run.mockImplementationOnce(failWith("You are not logged into any GitHub hosts. To log in, run: gh auth login"));
  const failure = await githubIssuePublisher("/app", new AbortController().signal, dependencies).create({ id, title: "A bug", body: "Useful report", beforePublish }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(IssuePublicationError);
  expect(failure).toMatchObject({ reason: "signed-out" });
  expect(beforePublish).not.toHaveBeenCalled();
});

it("classifies a rejected publication after the attempt started", async () => {
  const beforePublish = vi.fn();
  mocks.run.mockResolvedValueOnce({ stdout: "", stderr: "" }).mockImplementationOnce(failWith("GraphQL: API rate limit exceeded for user ID 1."));
  const failure = await githubIssuePublisher("/app", new AbortController().signal, dependencies).create({ id, title: "A bug", body: "Useful report", beforePublish }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ reason: "rate-limited" });
  expect(beforePublish).toHaveBeenCalledOnce();
});

it("checks GitHub CLI readiness read-only and reports a missing CLI", async () => {
  mocks.run.mockResolvedValueOnce({ stdout: "", stderr: "" });
  await expect(githubIssuePublisher("/app", new AbortController().signal, dependencies).status()).resolves.toBe("ready");
  expect(mocks.run.mock.calls[0]![1]).toEqual(["auth", "status", "--hostname", "github.com"]);
  mocks.run.mockImplementationOnce(failWith("To get started with GitHub CLI, please run:  gh auth login"));
  await expect(githubIssuePublisher("/app", new AbortController().signal, dependencies).status()).resolves.toBe("signed-out");
  const missing = { ...dependencies, executableCandidates: async () => [] };
  await expect(githubIssuePublisher("/app", new AbortController().signal, missing).status()).resolves.toBe("missing");
  expect(mocks.run).toHaveBeenCalledTimes(2);
});

function stubGh(stdout: string, exitCode: number): ChildProcessWithoutNullStreams {
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }) as unknown as ChildProcessWithoutNullStreams;
  setImmediate(() => {
    child.stdout.end(stdout);
    child.stderr.end();
    setImmediate(() => child.emit("close", exitCode));
  });
  return child;
}

it("classifies a GitHub CLI failure printed only to stdout before and after publication starts", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/restricted-cli-runner")>("../../src/server/restricted-cli-runner");
  const outputs = [
    { stdout: "github.com\n  X Failed to log in to github.com account octocat (keyring)\n  - The token in keyring is invalid.\n", exitCode: 1 },
    { stdout: "", exitCode: 0 },
    { stdout: "GraphQL: API rate limit exceeded for user ID 1.\n", exitCode: 1 },
  ];
  mocks.run.mockImplementation(async (executable: string, args: string[], options: Parameters<typeof actual.runRestrictedCli>[2]) => {
    const output = outputs.shift()!;
    return await actual.runRestrictedCli(executable, args, options, { spawn: () => stubGh(output.stdout, output.exitCode) });
  });
  const publisher = githubIssuePublisher("/app", new AbortController().signal, dependencies);
  await expect(publisher.status()).resolves.toBe("signed-out");
  const beforePublish = vi.fn();
  await expect(publisher.create({ id, title: "A bug", body: "Useful report", beforePublish })).rejects.toMatchObject({ reason: "rate-limited" });
  expect(beforePublish).toHaveBeenCalledOnce();
});
