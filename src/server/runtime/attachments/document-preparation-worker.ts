import {
  parseDocumentPreparationWorkerRequest,
  type DocumentPreparationWorkerEvent,
} from "../../../node/document-preparation-worker-protocol";
import { DocumentAttachmentError } from "./attachment-errors";
import { performDocumentPreparation } from "./document-preparation-operation";

const port = process.parentPort;
if (port) {
  port.once("message", (event) => {
    const request = parseDocumentPreparationWorkerRequest(event.data);
    if (!request || request.type !== "document.prepare") { process.exit(1); return; }
    const finish = (result: DocumentPreparationWorkerEvent): void => {
      port.once("message", (event) => {
        const ack = parseDocumentPreparationWorkerRequest(event.data);
        process.exit(ack?.type === "document.result-ack" && ack.operationId === request.operationId
          ? result.ok ? 0 : 1 : 1);
      });
      port.postMessage(result);
    };
    void performDocumentPreparation(request.operation).then(
      (result) => finish({ type: "document.result", operationId: request.operationId, ok: true, result }),
      (error: unknown) => finish({
        type: "document.result", operationId: request.operationId, ok: false,
        message: error instanceof DocumentAttachmentError
          ? error.message.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 300)
          : "The document could not be decoded safely.",
      }),
    );
  });
}
