import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";
import { createDocumentPreparationRunner } from "./document-preparation-runner";

export const documentPreparationRunner = createDocumentPreparationRunner({
  spawn: () => utilityProcess.fork(
    fileURLToPath(new URL("./document-preparation-worker.js", import.meta.url)), [], {
      env: {},
      execArgv: ["--max-old-space-size=256"],
      stdio: "ignore",
      serviceName: "Inertia Document Decoder",
    },
  ),
});
