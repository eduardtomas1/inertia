import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getPullRequestCreateUrl,
  getRepositoryStatus,
  inspectGitRemoteRouting,
  parseGitRemoteWebTarget,
  pushCurrentBranch,
} from "../../src/server/git";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("Git remote routing", () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      rmSync(root, { recursive: true, force: true });
    });
  });

  function repository(branch = "feature/pr"): string {
    const root = mkdtempSync(join(tmpdir(), "inertia-git-remotes-"));
    roots.push(root);
    git(root, "init", "-b", branch);
    git(root, "config", "core.autocrlf", "false");
    git(root, "config", "user.name", "Inertia Test");
    git(root, "config", "user.email", "test@inertia.local");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, "add", "tracked.txt");
    git(root, "commit", "-m", "base");
    return root;
  }

  it.each([
    {
      remote: "git@github.com:example/inertia.git",
      target: { forge: "github", baseUrl: "https://github.com/example/inertia" },
    },
    {
      remote: "ssh://git@gitlab.com/example/inertia.git",
      target: { forge: "gitlab", baseUrl: "https://gitlab.com/example/inertia" },
    },
    {
      remote: "https://example-user:secret@bitbucket.org/example/inertia.git?token=secret#private",
      target: { forge: "bitbucket", baseUrl: "https://bitbucket.org/example/inertia" },
    },
  ])("parses and sanitizes $remote", ({ remote, target }) => {
    expect(parseGitRemoteWebTarget(remote)).toEqual(target);
  });

  it.each([
    "C:\\Users\\developer\\inertia",
    "C:/Users/developer/inertia",
    "file:///workspace/inertia",
    "../inertia",
    "https://dev.azure.com/example/inertia",
    "https://code.example.com/example/inertia.git",
    "https://github.attacker.example/example/inertia.git",
  ])("rejects unsupported or local remote URL %s", (remote) => {
    expect(parseGitRemoteWebTarget(remote)).toBeNull();
  });

  it("uses a sole fork remote without requiring origin or an upstream", async () => {
    const root = repository();
    git(root, "remote", "add", "fork", "git@github.com:developer/inertia.git");

    const status = await getRepositoryStatus(root);
    expect(status.hasRemote).toBe(true);
    expect(status.upstream).toBeNull();
    expect(status.pullRequest).toEqual({
      available: true,
      remoteName: "fork",
      forge: "github",
      unavailableReason: null,
    });
    await expect(getPullRequestCreateUrl(root)).resolves.toBe(
      "https://github.com/developer/inertia/compare/feature%2Fpr?expand=1",
    );
  });

  it("uses origin when it exists even before the branch has an upstream", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "https://gitlab.com/example/inertia.git");

    const status = await getRepositoryStatus(root);
    expect(status.upstream).toBeNull();
    expect(status.pullRequest.remoteName).toBe("origin");
    expect(status.pullRequest.available).toBe(true);
    await expect(getPullRequestCreateUrl(root)).resolves.toBe(
      "https://gitlab.com/example/inertia/-/merge_requests/new?merge_request[source_branch]=feature%2Fpr",
    );
  });

  it("prefers the effective push remote over the tracked remote", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "https://github.com/example/origin.git");
    git(root, "remote", "add", "upstream", "https://github.com/example/upstream.git");
    git(root, "remote", "add", "fork", "git@github.com:developer/fork.git");
    git(root, "update-ref", "refs/remotes/upstream/main", "HEAD");
    git(root, "config", "branch.feature/pr.remote", "upstream");
    git(root, "config", "branch.feature/pr.merge", "refs/heads/main");
    git(root, "config", "branch.feature/pr.pushRemote", "fork");

    const status = await getRepositoryStatus(root);
    expect(status.pullRequest.remoteName).toBe("fork");
    const routing = await inspectGitRemoteRouting(root, status.branch);
    expect(routing.selectedRemoteName).toBe("fork");
    expect(routing.target?.baseUrl).toBe("https://github.com/developer/fork");
    await expect(getPullRequestCreateUrl(root)).resolves.toContain(
      "github.com/developer/fork/compare/feature%2Fpr",
    );
  });

  it("uses the tracked remote when there is no push override", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "https://github.com/example/origin.git");
    git(root, "remote", "add", "upstream", "https://bitbucket.org/example/upstream.git");
    git(root, "update-ref", "refs/remotes/upstream/main", "HEAD");
    git(root, "config", "branch.feature/pr.remote", "upstream");
    git(root, "config", "branch.feature/pr.merge", "refs/heads/main");

    const routing = await inspectGitRemoteRouting(root, "feature/pr");
    expect(routing.selectedRemoteName).toBe("upstream");
    await expect(getPullRequestCreateUrl(root)).resolves.toBe(
      "https://bitbucket.org/example/upstream/pull-requests/new?source=feature%2Fpr",
    );
  });

  it("honors remote.pushDefault before the tracked or origin remote", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "https://github.com/example/origin.git");
    git(root, "remote", "add", "fork", "https://github.com/developer/fork.git");
    git(root, "config", "remote.pushDefault", "fork");

    const routing = await inspectGitRemoteRouting(root, "feature/pr");
    expect(routing.selectedRemoteName).toBe("fork");
  });

  it("pushes to the same effective push remote selected for PR routing", async () => {
    const root = repository();
    const upstream = mkdtempSync(join(tmpdir(), "inertia-upstream-"));
    const fork = mkdtempSync(join(tmpdir(), "inertia-fork-"));
    roots.push(upstream, fork);
    git(upstream, "init", "--bare");
    git(fork, "init", "--bare");
    git(root, "remote", "add", "upstream", upstream);
    git(root, "remote", "add", "fork", fork);
    git(root, "config", "branch.feature/pr.pushRemote", "fork");

    await pushCurrentBranch(root);

    expect(git(fork, "rev-parse", "--verify", "refs/heads/feature/pr"))
      .toBe(git(root, "rev-parse", "HEAD"));
    expect(existsSync(join(upstream, "refs", "heads", "feature", "pr")))
      .toBe(false);
  });

  it("uses the push URL rather than the fetch URL for a selected remote", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "https://github.com/example/upstream.git");
    git(root, "remote", "set-url", "--push", "origin", "git@github.com:developer/fork.git");

    const routing = await inspectGitRemoteRouting(root, "feature/pr");
    expect(routing.target?.baseUrl).toBe("https://github.com/developer/fork");
  });

  it("keeps actual remote presence separate from unsupported PR availability", async () => {
    const root = repository();
    git(root, "remote", "add", "origin", "ssh://git@ssh.dev.azure.com/v3/example/project/inertia");

    const status = await getRepositoryStatus(root);
    expect(status.hasRemote).toBe(true);
    expect(status.pullRequest).toEqual({
      available: false,
      remoteName: "origin",
      forge: null,
      unavailableReason: "unsupported-forge",
    });
    await expect(getPullRequestCreateUrl(root)).rejects.toThrow(
      "supported for GitHub, GitLab, and Bitbucket",
    );
  });

  it("does not guess between multiple unconfigured non-origin remotes", async () => {
    const root = repository();
    git(root, "remote", "add", "fork-one", "https://github.com/example/one.git");
    git(root, "remote", "add", "fork-two", "https://github.com/example/two.git");

    const routing = await inspectGitRemoteRouting(root, "feature/pr");
    expect(routing.hasRemote).toBe(true);
    expect(routing.selectedRemoteName).toBeNull();
    expect(routing.pullRequest.unavailableReason).toBe("ambiguous-remote");
  });

  it("reports no remote independently of branch state", async () => {
    const root = repository();
    const status = await getRepositoryStatus(root);

    expect(status.hasRemote).toBe(false);
    expect(status.pullRequest.unavailableReason).toBe("no-remotes");
    await expect(getPullRequestCreateUrl(root)).rejects.toThrow(
      "Add a Git remote",
    );
  });

  it("resolves a native nested repository path containing spaces", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "inertia-git-workspace-"));
    roots.push(workspace);
    const nested = join(workspace, "modules", "Nested Repository");
    mkdirSync(nested, { recursive: true });
    git(nested, "init", "-b", "feature/windows-path");
    git(nested, "config", "core.autocrlf", "false");
    git(nested, "config", "user.name", "Inertia Test");
    git(nested, "config", "user.email", "test@inertia.local");
    writeFileSync(join(nested, "tracked.txt"), "base\n");
    git(nested, "add", "tracked.txt");
    git(nested, "commit", "-m", "base");
    git(nested, "remote", "add", "fork", "https://github.com/example/nested.git");

    await expect(getPullRequestCreateUrl(nested)).resolves.toBe(
      "https://github.com/example/nested/compare/feature%2Fwindows-path?expand=1",
    );
  });
});
