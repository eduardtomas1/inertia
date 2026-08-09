import { describe, expect, it } from "vitest";

import {
  githubRepositorySlug,
  verifiedGitHubPullRequestUrl,
} from "../../src/server/git/github-pull-request";

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
  });
});
