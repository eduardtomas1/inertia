import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  githubRepositorySlug,
  resolveGitHubCli,
  verifiedGitHubPullRequestUrl,
} from "../../src/server/git/github-pull-request";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("GitHub pull request URL verification", () => {
  it("pins gh to the selected repository slug", () => {
    expect(githubRepositorySlug("https://github.com/openai/codex"))
      .toBe("openai/codex");
    expect(() => githubRepositorySlug("https://example.com/openai/codex"))
      .toThrow("selected GitHub repository is invalid");
  });
  it("accepts only a PR URL for the routed repository", () => {
    expect(verifiedGitHubPullRequestUrl(
      "Created https://github.com/openai/codex/pull/42\n",
      "https://github.com/openai/codex",
    )).toBe("https://github.com/openai/codex/pull/42");
    expect(verifiedGitHubPullRequestUrl(
      "https://github.com/attacker/repo/pull/42",
      "https://github.com/openai/codex",
    )).toBeNull();
    expect(verifiedGitHubPullRequestUrl(
      "https://example.com/openai/codex/pull/42",
      "https://github.com/openai/codex",
    )).toBeNull();
    expect(verifiedGitHubPullRequestUrl(
      "https://github.com/OpenAI/Codex/pull/42",
      "https://github.com/openai/codex",
    )).toBe("https://github.com/OpenAI/Codex/pull/42");
  });

  it("resolves gh from the discovered desktop environment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-gh-resolution-"));
    directories.push(directory);
    const executable = join(directory, process.platform === "win32" ? "gh.exe" : "gh");
    writeFileSync(executable, "fixture");
    if (process.platform !== "win32") chmodSync(executable, 0o700);

    await expect(resolveGitHubCli({
      environment: async () => ({
        env: { PATH: [directory, "/usr/bin", "/bin"].join(delimiter) },
        pathEntries: [directory, "/usr/bin", "/bin"],
      }),
    })).resolves.toEqual({
      executable: await realpath(executable),
      environment: { PATH: [directory, "/usr/bin", "/bin"].join(delimiter) },
    });
  });

  it("abandons stalled environment discovery when the caller cancels", async () => {
    const controller = new AbortController();
    const resolution = resolveGitHubCli({
      environment: async () => await new Promise(() => undefined),
    }, { signal: controller.signal });

    controller.abort();

    await expect(resolution).rejects.toMatchObject({
      code: "timeout",
      message: "GitHub CLI discovery was cancelled.",
    });
  });

  it("abandons stalled executable discovery when the caller cancels", async () => {
    const controller = new AbortController();
    const resolution = resolveGitHubCli({
      environment: async () => ({ env: { PATH: "/fake" }, pathEntries: ["/fake"] }),
      executableCandidates: async () => await new Promise(() => undefined),
    }, { signal: controller.signal });
    await Promise.resolve();

    controller.abort();

    await expect(resolution).rejects.toMatchObject({
      code: "timeout",
      message: "GitHub CLI discovery was cancelled.",
    });
  });
});
