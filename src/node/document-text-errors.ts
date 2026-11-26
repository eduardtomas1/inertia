export type DocumentExtractionFailureCode =
  | "content"
  | "document-encrypted"
  | "document-corrupt"
  | "document-empty"
  | "document-limit";

export const DOCUMENT_EXTRACTION_ERROR_MESSAGES: Readonly<
  Record<DocumentExtractionFailureCode, string>
> = {
  content: "Attachment content does not match its safe file type.",
  "document-encrypted": "Encrypted documents are not supported.",
  "document-corrupt": "The document is corrupt or unreadable.",
  "document-empty": "The document contains no readable text.",
  "document-limit": "The document exceeds safe extraction limits.",
};

export const MAX_DOCUMENT_ARCHIVE_ENTRIES = 2_048;
export const MAX_DOCUMENT_ARCHIVE_EXPANDED_BYTES = 32 * 1024 * 1024;
export const MAX_DOCUMENT_ARCHIVE_RATIO = 200;
export const MAX_DOCUMENT_ARCHIVE_RATIO_FLOOR_BYTES = 1_024;
export const MAX_DOCUMENT_XML_NODES = 200_000;
export const MAX_DOCUMENT_XML_DEPTH = 128;
export const MAX_DOCUMENT_TEXT_OUTPUT_CHARS = 1_000_000;
export const MAX_DOCUMENT_TABLE_ROWS = 10_000;
export const MAX_DOCUMENT_TABLE_COLUMNS = 512;
export const MAX_DOCUMENT_NOTEBOOK_CELLS = 10_000;
export const MAX_DOCUMENT_RTF_DEPTH = 128;
export const DOCUMENT_TEXT_TRUNCATED_NOTICE =
  "\n\n[Extracted text truncated at document extraction limits.]";

export class DocumentExtractionError extends Error {
  constructor(
    readonly code: DocumentExtractionFailureCode,
    message = DOCUMENT_EXTRACTION_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

export class DocumentExtractionTruncation extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DocumentExtractionTruncation";
  }
}
