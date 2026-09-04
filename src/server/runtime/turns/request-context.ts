import { createHash } from "node:crypto";
import {
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  ChatAttachment,
  InteractionMode,
  TurnRequestContext,
} from "../../../shared/contracts";
import { chatAttachmentKind } from "../../../shared/attachments";
import { MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN } from "../../../shared/conversation-context";
import {
  MAX_DOCUMENT_CONTEXT_TOTAL_BYTES,
  type DocumentAttachmentContext,
} from "../attachments/document-attachment-context";

export const MAX_EXECUTION_CONTEXT_REFERENCES = 32;
export const MAX_EXECUTION_MESSAGE_SEGMENTS = 48;
export const MAX_EXECUTION_PAYLOAD_BYTES = 240 * 1024;
export const MAX_EXECUTION_CONTEXT_BLOB_BYTES = 64 * 1024;

const MAX_VISIBLE_MESSAGE_BYTES = 64 * 1024;
const MAX_INTERNAL_INSTRUCTION_BYTES = 32 * 1024;
const MAX_INDIVIDUAL_INTERNAL_INSTRUCTION_BYTES = 16 * 1024;
const MAX_FILE_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_COUNT = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const SHA256_REFERENCE_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const BUILD_MODE_INSTRUCTION_LABEL = "build-mode";

export const BUILD_MODE_INSTRUCTION = [
  "In Build mode, inspect enough to act safely, then implement and validate promptly.",
  "Keep visible planning brief and operational; use a formal numbered plan only when the user requests one, the task is ambiguous, or safe staged coordination requires it.",
  "Do not finish while delegated, background, or other tool work you started is pending; wait for it and incorporate its result before the final response.",
  "The runtime cannot continue work or notify the user after the final response. If blocked, state the blocker and do not imply that work is still running.",
].join(" ");

export type TurnExecutionContextKind =
  | "attachment"
  | "file"
  | "diff"
  | "terminal"
  | "preview"
  | "review-note";

export interface HiddenProviderInstruction {
  label: string;
  text: string;
}

export interface TurnExecutionContextBlob {
  reference: string;
  digest: string;
  byteSize: number;
  content: string;
}

export interface TurnExecutionManifestReference {
  kind: TurnExecutionContextKind;
  label: string;
  reference: string;
  byteSize: number;
  truncated: boolean;
}

/**
 * Safe to persist or log. It deliberately carries no context body, assembled
 * provider prompt, image path, or hidden provider instruction text/digest.
 */
export interface SanitizedTurnExecutionManifest {
  version: 1;
  visibleMessageBytes: number;
  imageCount: number;
  imageBytes: number;
  contextReferenceCount: number;
  uniqueContextBlobCount: number;
  contextBytes: number;
  internalInstructionCount: number;
  internalInstructionBytes: number;
  executionSegmentCount: number;
  assembledPayloadBytes: number;
  references: TurnExecutionManifestReference[];
}

export interface PersistedTurnExecutionContext {
  manifest: SanitizedTurnExecutionManifest;
  blobs: TurnExecutionContextBlob[];
}

export interface AssembledTurnRequest {
  visibleContent: string;
  executionPrompt: string;
  imagePaths: string[];
  persistence: PersistedTurnExecutionContext;
}

export interface AssembleTurnRequestInput {
  cwd: string;
  visibleContent: string;
  /**
   * Normal user turns supply their authoritative persisted mode. Privileged
   * callers that omit a mode receive no interaction-mode instruction.
   */
  interactionMode?: InteractionMode;
  attachments?: readonly ChatAttachment[];
  imagePaths?: readonly string[];
  /** Privileged, bounded document text derived from verified attachment bytes. */
  documentContexts?: readonly DocumentAttachmentContext[];
  context?: TurnRequestContext;
  internalInstructions?: readonly HiddenProviderInstruction[];
}

interface MaterializedContext {
  kind: TurnExecutionContextKind;
  label: string;
  content: string;
  truncated: boolean;
}

const CONTEXT_KINDS = new Set<TurnExecutionContextKind>([
  "attachment",
  "file",
  "diff",
  "terminal",
  "preview",
  "review-note",
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function rejectUnsafeText(value: string, label: string): string {
  if (value.includes("\0")) throw new Error(`${label} contains an invalid null byte.`);
  return value.replace(/\r\n?/gu, "\n");
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = rejectUnsafeText(value, label);
  const bytes = byteLength(normalized);
  if (bytes === 0) throw new Error(`${label} is empty.`);
  if (bytes > maximum) throw new Error(`${label} exceeds the ${maximum.toLocaleString()} byte limit.`);
  return normalized;
}

function boundedLabel(value: string, label: string): string {
  const normalized = boundedText(value.trim(), label, 4_096);
  return normalized.replace(/\s+/gu, " ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function referenceFor(content: string): string {
  return `sha256:${sha256(content)}`;
}

export function validateExecutionContextReference(reference: string): string {
  const match = SHA256_REFERENCE_PATTERN.exec(reference);
  if (!match) throw new Error("Execution context contains a malformed content reference.");
  return match[1];
}

function requiredBoundedInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

export function parseSanitizedTurnExecutionManifest(
  value: unknown,
): SanitizedTurnExecutionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Turn execution manifest is malformed.");
  }
  const manifest = value as Partial<SanitizedTurnExecutionManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.references)) {
    throw new Error("Turn execution manifest uses an unsupported format.");
  }
  if (manifest.references.length > MAX_EXECUTION_CONTEXT_REFERENCES) {
    throw new Error("Turn execution manifest contains too many references.");
  }
  const references = manifest.references.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Turn execution manifest contains a malformed reference.");
    }
    const reference = value as Partial<TurnExecutionManifestReference>;
    if (
      typeof reference.kind !== "string"
      || !CONTEXT_KINDS.has(reference.kind as TurnExecutionContextKind)
      || typeof reference.label !== "string"
      || typeof reference.reference !== "string"
      || typeof reference.truncated !== "boolean"
    ) {
      throw new Error("Turn execution manifest contains a malformed reference.");
    }
    validateExecutionContextReference(reference.reference);
    return {
      kind: reference.kind as TurnExecutionContextKind,
      label: boundedLabel(reference.label, "Execution context label"),
      reference: reference.reference,
      byteSize: requiredBoundedInteger(
        reference.byteSize,
        "Execution context byte size",
        MAX_EXECUTION_CONTEXT_BLOB_BYTES,
      ),
      truncated: reference.truncated,
    };
  });
  const parsed: SanitizedTurnExecutionManifest = {
    version: 1,
    visibleMessageBytes: requiredBoundedInteger(
      manifest.visibleMessageBytes,
      "Visible message byte size",
      MAX_VISIBLE_MESSAGE_BYTES,
    ),
    imageCount: requiredBoundedInteger(manifest.imageCount, "Image count", MAX_IMAGE_COUNT),
    imageBytes: requiredBoundedInteger(
      manifest.imageBytes,
      "Image byte size",
      MAX_TOTAL_IMAGE_BYTES,
    ),
    contextReferenceCount: requiredBoundedInteger(
      manifest.contextReferenceCount,
      "Execution context reference count",
      MAX_EXECUTION_CONTEXT_REFERENCES,
    ),
    uniqueContextBlobCount: requiredBoundedInteger(
      manifest.uniqueContextBlobCount,
      "Execution context blob count",
      MAX_EXECUTION_CONTEXT_REFERENCES,
    ),
    contextBytes: requiredBoundedInteger(
      manifest.contextBytes,
      "Execution context total byte size",
      MAX_EXECUTION_CONTEXT_REFERENCES * MAX_EXECUTION_CONTEXT_BLOB_BYTES,
    ),
    internalInstructionCount: requiredBoundedInteger(
      manifest.internalInstructionCount,
      "Internal instruction count",
      MAX_EXECUTION_MESSAGE_SEGMENTS,
    ),
    internalInstructionBytes: requiredBoundedInteger(
      manifest.internalInstructionBytes,
      "Internal instruction byte size",
      MAX_INTERNAL_INSTRUCTION_BYTES,
    ),
    executionSegmentCount: requiredBoundedInteger(
      manifest.executionSegmentCount,
      "Execution segment count",
      MAX_EXECUTION_MESSAGE_SEGMENTS,
    ),
    assembledPayloadBytes: requiredBoundedInteger(
      manifest.assembledPayloadBytes,
      "Assembled payload byte size",
      MAX_EXECUTION_PAYLOAD_BYTES,
    ),
    references,
  };
  if (
    parsed.contextReferenceCount !== references.length
    || parsed.contextBytes !== references.reduce((total, reference) => total + reference.byteSize, 0)
    || parsed.executionSegmentCount
      !== 1 + parsed.contextReferenceCount + parsed.internalInstructionCount
  ) {
    throw new Error("Turn execution manifest totals do not match its references.");
  }
  return parsed;
}

export function validatePersistedTurnExecutionContext(
  context: PersistedTurnExecutionContext,
): PersistedTurnExecutionContext {
  const manifest = parseSanitizedTurnExecutionManifest(context.manifest);
  if (!Array.isArray(context.blobs) || context.blobs.length !== manifest.uniqueContextBlobCount) {
    throw new Error("Turn execution context blob count does not match its manifest.");
  }
  const blobs = context.blobs.map((blob) => {
    const digest = validateExecutionContextReference(blob.reference);
    if (blob.digest !== digest || sha256(blob.content) !== digest) {
      throw new Error("Turn execution context blob digest does not match its content.");
    }
    const byteSize = byteLength(blob.content);
    if (
      byteSize !== blob.byteSize
      || byteSize <= 0
      || byteSize > MAX_EXECUTION_CONTEXT_BLOB_BYTES
    ) {
      throw new Error("Turn execution context blob has an invalid byte size.");
    }
    return { ...blob, digest, byteSize };
  });
  const blobsByReference = new Map(blobs.map((blob) => [blob.reference, blob]));
  if (manifest.references.some((reference) => {
    const blob = blobsByReference.get(reference.reference);
    return !blob || blob.byteSize !== reference.byteSize;
  })) {
    throw new Error("Turn execution manifest refers to missing or mismatched content.");
  }
  return { manifest, blobs };
}

function relativePathWithinWorkspace(cwd: string, inputPath: string): {
  absolutePath: string;
  displayPath: string;
} {
  const trimmed = boundedText(inputPath.trim(), "File reference path", 4_096);
  if (isAbsolute(trimmed)) throw new Error("File references must use project-relative paths.");
  const workspace = realpathSync(cwd);
  const candidate = realpathSync(resolve(workspace, trimmed));
  const relation = relative(workspace, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error("File reference resolves outside the project workspace.");
  }
  const file = statSync(candidate);
  if (!file.isFile()) throw new Error("File reference must resolve to a regular file.");
  if (file.size > MAX_FILE_SOURCE_BYTES) {
    throw new Error("File reference is too large to inspect safely.");
  }
  return {
    absolutePath: candidate,
    displayPath: relation || trimmed,
  };
}

function materializeFileReferences(
  cwd: string,
  references: NonNullable<TurnRequestContext["fileReferences"]>,
): MaterializedContext[] {
  return references.map((reference) => {
    const { absolutePath, displayPath } = relativePathWithinWorkspace(cwd, reference.path);
    const source = rejectUnsafeText(readFileSync(absolutePath, "utf8"), `File reference ${displayPath}`);
    const lines = source.split("\n");
    const lineStart = reference.lineStart ?? 1;
    const lineEnd = reference.lineEnd ?? lines.length;
    if (
      !Number.isSafeInteger(lineStart)
      || !Number.isSafeInteger(lineEnd)
      || lineStart < 1
      || lineEnd < lineStart
      || lineEnd > lines.length
    ) {
      throw new Error(`File reference ${displayPath} has an invalid line range.`);
    }
    const content = boundedText(
      lines.slice(lineStart - 1, lineEnd).join("\n"),
      `File reference ${displayPath}`,
      MAX_EXECUTION_CONTEXT_BLOB_BYTES,
    );
    return {
      kind: "file",
      label: lineStart === 1 && lineEnd === lines.length
        ? displayPath
        : `${displayPath}:${lineStart}-${lineEnd}`,
      content,
      truncated: false,
    };
  });
}

function materializeContext(
  cwd: string,
  context: TurnRequestContext = {},
  documents: readonly DocumentAttachmentContext[] = [],
): MaterializedContext[] {
  if (documents.length > 8) {
    throw new Error("Execution context contains too many document attachments.");
  }
  if ((context.fileReferences?.length ?? 0) > 16) {
    throw new Error("Execution context contains too many file references.");
  }
  if ((context.diffSelections?.length ?? 0) > 8) {
    throw new Error("Execution context contains too many diff selections.");
  }
  if ((context.terminalContexts?.length ?? 0) > 8) {
    throw new Error("Execution context contains too many terminal selections.");
  }
  if ((context.previewContexts?.length ?? 0) > 8) {
    throw new Error("Execution context contains too many preview selections.");
  }
  if ((context.reviewNotes?.length ?? 0) > 16) {
    throw new Error("Execution context contains too many review notes.");
  }
  if (
    (context.conversationContexts?.length ?? 0)
      > MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN
  ) {
    throw new Error("Execution context contains too many chat context packets.");
  }
  const documentContextBytes = documents.reduce(
    (total, document) =>
      total + byteLength(JSON.stringify(document.content).slice(1, -1)),
    0,
  );
  if (documentContextBytes > MAX_DOCUMENT_CONTEXT_TOTAL_BYTES) {
    throw new Error("Document attachments exceed the shared turn context limit.");
  }
  const materialized = documents.map((document): MaterializedContext => ({
    kind: "attachment",
    label: boundedLabel(document.label, "Document attachment label"),
    content: boundedText(
      document.content,
      `Document attachment ${document.label}`,
      MAX_EXECUTION_CONTEXT_BLOB_BYTES,
    ),
    truncated: document.truncated,
  }));
  materialized.push(
    ...materializeFileReferences(cwd, context.fileReferences ?? []),
  );

  for (const packet of context.conversationContexts ?? []) {
    materialized.push({
      kind: "attachment",
      label: boundedLabel(packet.label, "Chat context label"),
      content: boundedText(
        packet.content,
        `Chat context ${packet.packetId}`,
        MAX_EXECUTION_CONTEXT_BLOB_BYTES,
      ),
      truncated: false,
    });
  }

  for (const selection of context.diffSelections ?? []) {
    const path = boundedLabel(selection.path, "Diff path");
    const hunk = boundedLabel(selection.hunkHeader, "Diff hunk");
    if (
      !Number.isSafeInteger(selection.selectedLineCount)
      || selection.selectedLineCount < 1
      || selection.selectedLineCount > 500
    ) {
      throw new Error(`Selected diff ${path} has an invalid line count.`);
    }
    materialized.push({
      kind: "diff",
      label: `${path} · ${hunk} · ${selection.selectedLineCount} selected lines`,
      content: boundedText(
        selection.content,
        `Selected diff ${path}`,
        MAX_EXECUTION_CONTEXT_BLOB_BYTES,
      ),
      truncated: selection.truncated === true,
    });
  }

  for (const terminal of context.terminalContexts ?? []) {
    const terminalId = boundedLabel(terminal.terminalId, "Terminal ID");
    const terminalLabel = boundedLabel(terminal.terminalLabel, "Terminal label");
    if (
      !Number.isSafeInteger(terminal.lineStart)
      || !Number.isSafeInteger(terminal.lineEnd)
      || terminal.lineStart < 1
      || terminal.lineEnd < terminal.lineStart
    ) {
      throw new Error(`Terminal context ${terminalId} has an invalid line range.`);
    }
    materialized.push({
      kind: "terminal",
      label: `${terminalLabel} · lines ${terminal.lineStart}-${terminal.lineEnd}`,
      content: boundedText(
        terminal.content,
        `Terminal context ${terminalId}`,
        MAX_EXECUTION_CONTEXT_BLOB_BYTES,
      ),
      truncated: false,
    });
  }

  for (const preview of context.previewContexts ?? []) {
    const url = boundedText(preview.url.trim(), "Preview URL", 8_192);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error("Preview context contains an invalid URL.");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Preview context URL must use HTTP or HTTPS.");
    }
    if (
      preview.sourceLine !== undefined
      && (
        !Number.isSafeInteger(preview.sourceLine)
        || preview.sourceLine < 1
        || preview.sourceLine > 10_000_000
      )
    ) {
      throw new Error("Preview context contains an invalid source line.");
    }
    const serialized = JSON.stringify({
      url,
      ...(preview.title ? { title: rejectUnsafeText(preview.title, "Preview title") } : {}),
      ...(preview.selector ? { selector: rejectUnsafeText(preview.selector, "Preview selector") } : {}),
      ...(preview.componentName
        ? { componentName: rejectUnsafeText(preview.componentName, "Preview component") }
        : {}),
      ...(preview.sourcePath
        ? {
            source: {
              path: rejectUnsafeText(preview.sourcePath, "Preview source path"),
              ...(preview.sourceLine ? { line: preview.sourceLine } : {}),
            },
          }
        : {}),
      ...(preview.html ? { html: rejectUnsafeText(preview.html, "Preview HTML") } : {}),
      ...(preview.styles ? { styles: rejectUnsafeText(preview.styles, "Preview styles") } : {}),
    });
    materialized.push({
      kind: "preview",
      label: boundedLabel(
        preview.componentName
          ?? preview.selector
          ?? preview.title
          ?? `${parsedUrl.origin}${parsedUrl.pathname}`,
        "Preview context label",
      ),
      content: boundedText(
        serialized,
        "Preview context",
        MAX_EXECUTION_CONTEXT_BLOB_BYTES,
      ),
      truncated: false,
    });
  }

  for (const note of context.reviewNotes ?? []) {
    const path = boundedLabel(note.path, "Review note path");
    const body = boundedText(note.body.trim(), `Review note ${path}`, 8_192);
    if ((note.lineIds?.length ?? 0) > 500) {
      throw new Error(`Review note ${path} contains too many line references.`);
    }
    const serialized = JSON.stringify({
      path,
      ...(note.noteId ? { noteId: boundedLabel(note.noteId, "Review note ID") } : {}),
      ...(note.hunkId ? { hunkId: boundedLabel(note.hunkId, "Review note hunk") } : {}),
      ...(note.lineIds ? { lineIds: note.lineIds.map((id) => boundedLabel(id, "Review note line ID")) } : {}),
      body,
      stale: note.stale === true,
    });
    materialized.push({
      kind: "review-note",
      label: `${path}${note.hunkId ? ` · ${note.hunkId}` : ""}${note.stale ? " · stale" : ""}`,
      content: boundedText(
        serialized,
        `Review note ${path}`,
        MAX_EXECUTION_CONTEXT_BLOB_BYTES,
      ),
      truncated: false,
    });
  }

  if (materialized.length > MAX_EXECUTION_CONTEXT_REFERENCES) {
    throw new Error(
      `Execution context exceeds the ${MAX_EXECUTION_CONTEXT_REFERENCES} reference limit.`,
    );
  }
  return materialized;
}

function validateImages(
  attachments: readonly ChatAttachment[],
  requestedPaths: readonly string[] | undefined,
): { imagePaths: string[]; imageBytes: number } {
  const images = attachments.filter(({ mimeType }) =>
    chatAttachmentKind(mimeType) === "image");
  const paths = requestedPaths ?? images.map(({ path }) => path);
  if (paths.length > MAX_IMAGE_COUNT) {
    throw new Error(`Attach at most ${MAX_IMAGE_COUNT} images to one turn.`);
  }
  const declaredByPath = new Map(images.map((attachment) => [attachment.path, attachment]));
  const seen = new Set<string>();
  let imageBytes = 0;
  const imagePaths = paths.map((path) => {
    const normalized = boundedText(path.trim(), "Image path", 4_096);
    if (!isAbsolute(normalized)) throw new Error("Image paths must be absolute.");
    const canonical = realpathSync(normalized);
    if (seen.has(canonical)) throw new Error("The same image is attached more than once.");
    seen.add(canonical);
    const file = statSync(canonical);
    if (!file.isFile() || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
      throw new Error("An image attachment is empty, missing, or too large.");
    }
    const declared = declaredByPath.get(path);
    if (declared && declared.size > MAX_IMAGE_BYTES) {
      throw new Error("An image attachment exceeds its declared size limit.");
    }
    imageBytes += file.size;
    return canonical;
  });
  if (imageBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error("Image attachments exceed the 20 MB turn limit.");
  }
  return { imagePaths, imageBytes };
}

export function assembleTurnRequest(input: AssembleTurnRequestInput): AssembledTurnRequest {
  const visibleContent = boundedText(
    input.visibleContent.trim(),
    "Visible user message",
    MAX_VISIBLE_MESSAGE_BYTES,
  );
  const contexts = materializeContext(
    input.cwd,
    input.context,
    input.documentContexts,
  );
  const { imagePaths, imageBytes } = validateImages(
    input.attachments ?? [],
    input.imagePaths,
  );
  const modeInstructions: readonly HiddenProviderInstruction[] =
    input.interactionMode === "build"
      ? [{
          label: BUILD_MODE_INSTRUCTION_LABEL,
          text: BUILD_MODE_INSTRUCTION,
        }]
      : [];
  const internalInstructions = [
    ...modeInstructions,
    ...(input.internalInstructions ?? []),
  ].map(({ label, text }) => ({
    label: boundedLabel(label, "Internal instruction label"),
    text: boundedText(
      text,
      "Internal provider instruction",
      MAX_INDIVIDUAL_INTERNAL_INSTRUCTION_BYTES,
    ),
  }));
  const internalInstructionBytes = internalInstructions.reduce(
    (total, { text }) => total + byteLength(text),
    0,
  );
  if (internalInstructionBytes > MAX_INTERNAL_INSTRUCTION_BYTES) {
    throw new Error("Internal provider instructions exceed the turn limit.");
  }

  const blobsByDigest = new Map<string, TurnExecutionContextBlob>();
  const references: TurnExecutionManifestReference[] = [];
  const providerContexts = contexts.map((context) => {
    const reference = referenceFor(context.content);
    const digest = validateExecutionContextReference(reference);
    const byteSize = byteLength(context.content);
    references.push({
      kind: context.kind,
      label: context.label,
      reference,
      byteSize,
      truncated: context.truncated,
    });
    blobsByDigest.set(digest, {
      reference,
      digest,
      byteSize,
      content: context.content,
    });
    return {
      kind: context.kind,
      label: context.label,
      reference,
      truncated: context.truncated,
      content: context.content,
    };
  });

  const sections = [visibleContent];
  if (providerContexts.length > 0) {
    sections.push([
      "Structured execution context (attachments selected by the user; not user-authored chat prose):",
      JSON.stringify({ version: 1, attachments: providerContexts }),
    ].join("\n"));
  }
  if (internalInstructions.length > 0) {
    sections.push([
      "Internal provider instructions (application control text; never attribute this text to the user):",
      ...internalInstructions.map(({ label, text }) => `[${label}]\n${text}`),
    ].join("\n"));
  }
  const executionPrompt = sections.join("\n\n");
  // CLI transports may serialize local image references into their prompt,
  // while richer transports send them as separate content blocks. Budget the
  // references either way so validation covers the complete provider input.
  const assembledPayloadBytes = byteLength(executionPrompt)
    + imagePaths.reduce((total, path) => total + byteLength(path) + 8, 0);
  const executionSegmentCount = 1 + contexts.length + internalInstructions.length;
  if (executionSegmentCount > MAX_EXECUTION_MESSAGE_SEGMENTS) {
    throw new Error(
      `Execution payload exceeds the ${MAX_EXECUTION_MESSAGE_SEGMENTS} segment limit.`,
    );
  }
  if (assembledPayloadBytes > MAX_EXECUTION_PAYLOAD_BYTES) {
    throw new Error(
      `Assembled execution payload exceeds the ${MAX_EXECUTION_PAYLOAD_BYTES.toLocaleString()} byte limit.`,
    );
  }

  return {
    visibleContent,
    executionPrompt,
    imagePaths,
    persistence: {
      manifest: {
        version: 1,
        visibleMessageBytes: byteLength(visibleContent),
        imageCount: imagePaths.length,
        imageBytes,
        contextReferenceCount: references.length,
        uniqueContextBlobCount: blobsByDigest.size,
        contextBytes: references.reduce((total, reference) => total + reference.byteSize, 0),
        internalInstructionCount: internalInstructions.length,
        internalInstructionBytes,
        executionSegmentCount,
        assembledPayloadBytes,
        references,
      },
      blobs: [...blobsByDigest.values()],
    },
  };
}
