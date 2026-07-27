import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  sep,
} from "node:path";

import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentMimeTypeForName,
} from "../../../shared/attachments.js";
import type { ChatAttachment } from "../../../shared/contracts.js";
import type { TrustedRuntimeAttachment } from "../../../shared/runtime-attachments.js";

export interface RuntimeAttachmentBroker {
  resolve(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null>;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function publicAttachmentError(): Error {
  return new Error("The selected attachment is no longer available or could not be verified.");
}

function storageExtension(
  mimeType: TrustedRuntimeAttachment["mimeType"],
): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    case "application/pdf": return "pdf";
    case "text/plain": return "txt";
    case "text/markdown": return "md";
    case "text/csv": return "csv";
    case "application/json": return "json";
  }
}

export class TrustedAttachmentResolver {
  constructor(
    private readonly trustedRoot: string,
    private readonly broker: RuntimeAttachmentBroker,
  ) {}

  async resolveAll(
    requested: readonly ChatAttachment[],
    signal?: AbortSignal,
  ): Promise<ChatAttachment[]> {
    if (requested.length > MAX_CHAT_ATTACHMENTS) throw publicAttachmentError();
    if (requested.length === 0) return [];
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.trustedRoot);
    } catch {
      throw publicAttachmentError();
    }
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    const resolved: ChatAttachment[] = [];
    let totalBytes = 0;
    for (const untrusted of requested) {
      if (signal?.aborted) throw publicAttachmentError();
      if (seenIds.has(untrusted.id)) throw publicAttachmentError();
      seenIds.add(untrusted.id);
      const trusted = await this.broker.resolve(untrusted.id, signal);
      if (!trusted || trusted.id !== untrusted.id) throw publicAttachmentError();
      const attachment = await this.revalidate(canonicalRoot, trusted, signal);
      if (seenPaths.has(attachment.path)) throw publicAttachmentError();
      seenPaths.add(attachment.path);
      totalBytes += attachment.size;
      if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) throw publicAttachmentError();
      resolved.push(attachment);
    }
    return resolved;
  }

  private async revalidate(
    canonicalRoot: string,
    trusted: TrustedRuntimeAttachment,
    signal?: AbortSignal,
  ): Promise<ChatAttachment> {
    try {
      if (
        trusted.size < 1
        || trusted.size > MAX_CHAT_ATTACHMENT_BYTES
        || !/^[0-9a-f]{64}$/u.test(trusted.digest)
        || chatAttachmentMimeTypeForName(trusted.name) !== trusted.mimeType
      ) throw publicAttachmentError();
      const pathInfo = await lstat(trusted.path);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw publicAttachmentError();
      const canonicalPath = await realpath(trusted.path);
      if (
        !isContained(canonicalRoot, canonicalPath)
        || canonicalPath !== trusted.path
        || basename(canonicalPath)
          !== `${trusted.id}.${storageExtension(trusted.mimeType)}`
      ) throw publicAttachmentError();
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
      const file = await open(canonicalPath, constants.O_RDONLY | noFollow);
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size !== trusted.size) throw publicAttachmentError();
        if (signal?.aborted) throw publicAttachmentError();
        const bytes = await file.readFile();
        const after = await file.stat();
        if (
          signal?.aborted
          || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs
          || createHash("sha256").update(bytes).digest("hex") !== trusted.digest
        ) throw publicAttachmentError();
      } finally {
        await file.close();
      }
      return {
        id: trusted.id,
        name: trusted.name,
        path: canonicalPath,
        mimeType: trusted.mimeType,
        size: trusted.size,
      };
    } catch {
      throw publicAttachmentError();
    }
  }
}
