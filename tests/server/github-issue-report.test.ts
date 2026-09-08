import { afterEach, describe, expect, it, vi } from "vitest";
import { githubIssuePublisher } from "../../src/server/git/github-issue-report";
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
