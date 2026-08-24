import {
  AttachmentImportValidationError,
  validateAttachmentImportFile,
} from "./attachment-import-file.js";
import {
  parseAttachmentImportWorkerRequest,
  type AttachmentImportWorkerEvent,
} from "./attachment-import-worker-protocol.js";

const parentPort = process.parentPort;

if (parentPort) {
  parentPort.once("message", (event) => {
    const request = parseAttachmentImportWorkerRequest(event.data);
    if (!request) {
      parentPort.postMessage({
        type: "attachment-import.result",
        ok: false,
        code: "unsafe",
      } satisfies AttachmentImportWorkerEvent);
      setImmediate(() => process.exit(1));
      return;
    }
    void validateAttachmentImportFile(request.operation, {
      requirePinnedCwd: true,
    }).then(
      (receipt) => {
        parentPort.postMessage({
          type: "attachment-import.result",
          ok: true,
          receipt,
        } satisfies AttachmentImportWorkerEvent);
        setImmediate(() => process.exit(0));
      },
      (error: unknown) => {
        parentPort.postMessage({
          type: "attachment-import.result",
          ok: false,
          code: error instanceof AttachmentImportValidationError
            ? error.code
            : "unsafe",
        } satisfies AttachmentImportWorkerEvent);
        setImmediate(() => process.exit(1));
      },
    );
  });
}
