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
    if (!request || request.type !== "attachment-import.validate") {
      process.exit(1);
      return;
    }
    const finish = (result: AttachmentImportWorkerEvent, exitCode: number): void => {
      parentPort.once("message", (acknowledgement) => {
        const ack = parseAttachmentImportWorkerRequest(acknowledgement.data);
        process.exit(
          ack?.type === "attachment-import.result-ack"
              && ack.operationId === request.operationId
            ? exitCode
            : 1,
        );
      });
      parentPort.postMessage(result);
    };
    void validateAttachmentImportFile(request.operation, {
      requirePinnedCwd: true,
    }).then(
      (receipt) => {
        finish({
          type: "attachment-import.result",
          operationId: request.operationId,
          ok: true,
          receipt,
        } satisfies AttachmentImportWorkerEvent, 0);
      },
      (error: unknown) => {
        finish({
          type: "attachment-import.result",
          operationId: request.operationId,
          ok: false,
          code: error instanceof AttachmentImportValidationError
            ? error.code
            : "unsafe",
        } satisfies AttachmentImportWorkerEvent, 1);
      },
    );
  });
}
