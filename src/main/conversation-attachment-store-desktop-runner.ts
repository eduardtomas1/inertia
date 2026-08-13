import { fileURLToPath } from "node:url";

import { utilityProcess } from "electron";

import { createConversationAttachmentStoreUtilityRunner } from "./conversation-attachment-store-runner.js";

export const conversationAttachmentStoreRunner =
  createConversationAttachmentStoreUtilityRunner({
    spawn: (cwd) => utilityProcess.fork(
      fileURLToPath(new URL(
        "./conversation-attachment-store-worker.js",
        import.meta.url,
      )),
      [],
      {
        cwd,
        env: {},
        stdio: "ignore",
        serviceName: "Inertia Attachment Store",
      },
    ),
  });
