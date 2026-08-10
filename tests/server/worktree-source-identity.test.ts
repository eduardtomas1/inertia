import { describe, expect, it } from "vitest";

import {
  type PinnedWorktreeSourceIdentity,
  worktreeSourceIdentitiesEqual,
  worktreeSourceIdentityKey,
} from "../../src/server/runtime/worktree-source-identity";

function sourceIdentity(
  workspace: string,
  root: string,
  gitDirectory: string,
  commonDirectory: string,
): PinnedWorktreeSourceIdentity {
  return {
    canonicalWorkspace: workspace,
    workspaceDevice: "11",
    workspaceInode: "12",
    workspaceBirthtimeNs: "13",
    root,
    rootDevice: "21",
    rootInode: "22",
    rootBirthtimeNs: "23",
    metadataMarkerIdentity: [
      "git-dir",
      gitDirectory,
      "31",
      "32",
      "33",
      "git-common-dir",
      commonDirectory,
      "41",
      "42",
      "43",
    ].join("\0"),
  };
}

describe("isolated-worktree source identity", () => {
  it("accepts equivalent filesystem identities with different path spellings", () => {
    const long = sourceIdentity(
      "C:\\Program Files\\Inertia\\project",
      "C:\\Program Files\\Inertia\\project",
      "C:\\Program Files\\Inertia\\project\\.git",
      "C:\\Program Files\\Inertia\\project\\.git",
    );
    const short = sourceIdentity(
      "C:\\PROGRA~1\\Inertia\\project",
      "C:\\PROGRA~1\\Inertia\\project",
      "C:\\PROGRA~1\\Inertia\\project\\.git",
      "C:\\PROGRA~1\\Inertia\\project\\.git",
    );

    expect(worktreeSourceIdentitiesEqual(long, short)).toBe(true);
    expect(worktreeSourceIdentityKey(long)).toBe(
      worktreeSourceIdentityKey(short),
    );
  });

  it("rejects metadata replacement even when its reported path is unchanged", () => {
    const pinned = sourceIdentity("/workspace", "/workspace", "/git", "/git");
    const replacementMarker = pinned.metadataMarkerIdentity.split("\0");
    replacementMarker[8] = "99";
    const replaced: PinnedWorktreeSourceIdentity = {
      ...pinned,
      metadataMarkerIdentity: replacementMarker.join("\0"),
    };

    expect(worktreeSourceIdentitiesEqual(pinned, replaced)).toBe(false);
  });
});
