import { describe, expect, it } from "vitest";

import type { WorkspaceGitSnapshot } from "../../src/shared/contracts";
import {
  firstWorkspaceGitFile,
  parseWorkspaceGitIdentity,
  workspaceGitFilePath,
  workspaceGitIdentity,
  workspaceGitRepositoryLabel,
  workspaceGitRepositoryPresentation,
} from "../../src/renderer/src/utils/workspaceGit";

const changedFile = (path: string) => ({
  path,
  status: "modified",
  insertions: 1,
  deletions: 0,
  untracked: false,
  staged: false,
  unstaged: true,
  indexStatus: ".",
  worktreeStatus: "M",
});

const snapshot: WorkspaceGitSnapshot = {
  repositories: [
    {
      repositoryPath: "modules/alpha",
      state: "ready",
      error: null,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: false,
      files: [changedFile("src/Main.java")],
      insertions: 1,
      deletions: 0,
      clean: false,
      truncated: false,
    },
    {
      repositoryPath: "modules/beta",
      state: "ready",
      error: null,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      hasRemote: false,
      files: [changedFile("src/Main.java")],
      insertions: 1,
      deletions: 0,
      clean: false,
      truncated: false,
    },
  ],
  files: 2,
  insertions: 2,
  deletions: 0,
  scannedDirectories: 4,
  skippedDirectories: 0,
  partial: false,
  truncated: false,
  issues: [],
};

describe("workspace Git renderer identity", () => {
  it("does not flatten identical paths from different repositories", () => {
    const alpha = { repositoryPath: "modules/alpha", filePath: "src/Main.java" };
    const beta = { repositoryPath: "modules/beta", filePath: "src/Main.java" };

    expect(workspaceGitIdentity(alpha)).not.toBe(workspaceGitIdentity(beta));
    expect(parseWorkspaceGitIdentity(workspaceGitIdentity(alpha), snapshot)).toEqual(alpha);
    expect(parseWorkspaceGitIdentity(workspaceGitIdentity(beta), snapshot)).toEqual(beta);
    expect(workspaceGitFilePath(alpha)).toBe("modules/alpha/src/Main.java");
    expect(workspaceGitFilePath(beta)).toBe("modules/beta/src/Main.java");
  });

  it("chooses the first changed repository deterministically and labels the root safely", () => {
    expect(firstWorkspaceGitFile(snapshot)).toEqual({
      repositoryPath: "modules/alpha",
      filePath: "src/Main.java",
    });
    expect(workspaceGitRepositoryLabel("Openbravo", ".")).toBe("Openbravo");
    expect(workspaceGitRepositoryLabel("Openbravo", "modules/alpha")).toBe("modules/alpha");
    expect(workspaceGitRepositoryPresentation("Openbravo", ".")).toEqual({
      prefix: "",
      suffix: "Openbravo",
      location: "project root",
    });
    expect(
      workspaceGitRepositoryPresentation(
        "Openbravo",
        "modules/org.openbravo.client.application-alpha",
      ),
    ).toEqual({
      prefix: "org.openbravo.client.application-",
      suffix: "alpha",
      location: "modules",
    });
  });

  it("rejects stale or forged selection keys", () => {
    expect(parseWorkspaceGitIdentity("13:modules/alphasrc/Missing.java", snapshot)).toBeNull();
    expect(parseWorkspaceGitIdentity("oops", snapshot)).toBeNull();
  });
});
