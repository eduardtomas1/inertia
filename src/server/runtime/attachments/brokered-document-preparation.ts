import {
  DOCUMENT_PREPARATION_TIMEOUT_MS,
  type DocumentPreparationRunner,
} from "../../../node/document-preparation";
import { DocumentAttachmentError } from "./attachment-errors";
import { prepareDocumentAttachments } from "./document-attachment-context";

export function createBrokeredDocumentPreparer(runner: DocumentPreparationRunner): typeof prepareDocumentAttachments {
  return async (payloads, options = {}) => {
    if (!payloads.some(({ attachment }) => attachment.mimeType === "application/pdf")) {
      return await prepareDocumentAttachments(payloads, options);
    }
    const now = options.now ?? Date.now;
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, now() + DOCUMENT_PREPARATION_TIMEOUT_MS);
    const checkPending = (): void => {
      if (options.signal?.aborted || now() >= deadlineAt) throw new DocumentAttachmentError("Document preparation was cancelled or expired.");
    };
    checkPending();
    const execution = runner({ deadlineAt, payloads: payloads.map(({ attachment, bytes }) => ({
      id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, bytes,
    })) }, options.signal);
    // Observe both promises immediately; a fatal decoder error can settle them together.
    const stopped = execution.stopped.then(() => true, () => false);
    const adopted: string[] = [];
    try {
      const result = await execution.result;
      if (!await stopped) throw new DocumentAttachmentError("Document decoder shutdown is unconfirmed.");
      checkPending();
      if (result.images.length > 0 && !options.generatedAttachmentStore) {
        throw new DocumentAttachmentError("Scanned PDF pages require private generated-attachment storage.");
      }
      const generated = new Map<string, string>();
      for (const image of result.images) {
        checkPending();
        const path = await options.generatedAttachmentStore!.writeJpeg(image.bytes);
        adopted.push(path);
        generated.set(image.id, path);
      }
      checkPending();
      const source = new Map(payloads.map(({ attachment }) => [attachment.id, attachment.path]));
      const imagePaths = result.imageOrder.map((entry) => {
        const path = "sourceId" in entry ? source.get(entry.sourceId) : generated.get(entry.generatedId);
        if (!path) throw new DocumentAttachmentError("Document preparation returned an unknown image identity.");
        return path;
      });
      return { contexts: result.contexts, generatedImagePaths: imagePaths.filter((path) => adopted.includes(path)), imagePaths };
    } catch (error) {
      await stopped;
      await options.generatedAttachmentStore?.release(adopted).catch(() => undefined);
      throw error instanceof DocumentAttachmentError ? error : new DocumentAttachmentError("The PDF could not be prepared safely.");
    }
  };
}
