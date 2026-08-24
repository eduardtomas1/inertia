import { fileURLToPath } from "node:url";

import { utilityProcess } from "electron";

import { createAttachmentImportUtilityRunner } from "./attachment-import-runner.js";

export const attachmentImportRunner = createAttachmentImportUtilityRunner({
  spawn: (cwd) => utilityProcess.fork(
    fileURLToPath(new URL("./attachment-import-worker.js", import.meta.url)),
    [],
    {
      cwd,
      env: {},
      stdio: "ignore",
      serviceName: "Inertia Attachment Validation",
    },
  ),
});
