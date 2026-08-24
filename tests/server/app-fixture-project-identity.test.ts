import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { runGit } from "../../src/server/git/runner";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { ProjectIdentityRefresher } from "../../src/server/project-identity-refresh";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import { seedAppConversation } from "../support/seed-app-conversation";

describe("app fixture project identity", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
  });

  it("seeds authoritative identity before the startup refresh", async () => {
    const testDirectory = mkdtempSync(join(tmpdir(), "inertia-app-identity-"));
    directories.push(testDirectory);
    const workspaceDirectory = join(testDirectory, "Inertia");
    const secondWorkspaceDirectory = join(testDirectory, "Companion");
    const dataDirectory = join(testDirectory, "data");
    mkdirSync(workspaceDirectory);
    mkdirSync(secondWorkspaceDirectory);
    mkdirSync(dataDirectory);
    await Promise.all([
      runGit(workspaceDirectory, ["init", "-q"], {
        failureMessage: "The primary fixture repository could not be initialized.",
      }),
      runGit(secondWorkspaceDirectory, ["init", "-q"], {
        failureMessage: "The secondary fixture repository could not be initialized.",
      }),
    ]);

    await seedAppConversation({
      testDirectory,
      workspaceDirectory,
      name: "identity",
      seedAssistantCodeBlock: false,
      secondWorkspaceDirectory,
    });

    const store = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      workspaceDirectory,
      { recoverInterruptedRuns: false },
    );
    try {
      const beforeRefresh = store.shellSnapshot().projects;
      for (const project of beforeRefresh) {
        expect(project).toMatchObject(
          await inspectProjectIdentity(project.path),
        );
      }

      const refresher = new ProjectIdentityRefresher({
        apply: (projectId, identity) => {
          store.updateProject(projectId, identity);
        },
      });
      await refresher.refreshAll(beforeRefresh.map(({ id, path }) => ({
        id,
        path,
      })));

      expect(store.shellSnapshot().projects).toEqual(beforeRefresh);
    } finally {
      store.close();
    }
  });
});
