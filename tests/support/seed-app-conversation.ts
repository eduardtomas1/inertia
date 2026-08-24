import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";

interface SeedAppConversationOptions {
  testDirectory: string;
  workspaceDirectory: string;
  name: string;
  seedAssistantCodeBlock: boolean;
  secondWorkspaceDirectory: string | null;
}

export async function seedAppConversation({
  testDirectory,
  workspaceDirectory,
  name,
  seedAssistantCodeBlock,
  secondWorkspaceDirectory,
}: SeedAppConversationOptions): Promise<void> {
  const identity = await inspectProjectIdentity(workspaceDirectory);
  const secondIdentity = secondWorkspaceDirectory
    ? await inspectProjectIdentity(secondWorkspaceDirectory)
    : null;
  const store = new RuntimeStore(
    join(testDirectory, "data", "inertia.sqlite"),
    workspaceDirectory,
    { recoverInterruptedRuns: false },
  );
  try {
    const project = store.createProject(
      "Inertia",
      workspaceDirectory,
      identity,
    );
    const conversation = store.createConversation(
      project.id,
      `${name} fixture`,
    );
    if (secondWorkspaceDirectory && secondIdentity) {
      const secondProject = store.createProject(
        "Companion",
        secondWorkspaceDirectory,
        secondIdentity,
      );
      store.createConversation(
        secondProject.id,
        `${name} companion`,
      );
      store.selectConversation(conversation.id);
    }
    if (seedAssistantCodeBlock) {
      store.createMessage(
        conversation.id,
        [
          "# Settings fixture",
          "",
          "```ts file=src/settings.ts",
          "const ready: boolean = true;",
          "```",
        ].join("\n"),
        "assistant",
      );
    }
  } finally {
    store.close();
  }
}
