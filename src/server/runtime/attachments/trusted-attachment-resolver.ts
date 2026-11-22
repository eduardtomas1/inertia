import { snapshotSourceSchema } from "../../../shared/snapshots";
import { readAttachment, type AttachmentFileSource } from "../../../node/read-attachment.js";
import { constants, lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../../../node/platform-file-open-flags.js";
import {
  MAX_ATTACHMENT_COUNT,
  attachmentLimitError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  storedAttachmentTypeMatchesName,
  chatAttachmentStorageExtension,
  chatAttachmentKind,
  MAX_IMAGE_ATTACHMENT_BYTES,
} from "../../../shared/attachments.js";
import type { ChatAttachment } from "../../../shared/contracts.js";
import type { TrustedRuntimeAttachment } from "../../../shared/runtime-attachments.js";
import { AttachmentResolutionError } from "./attachment-errors.js";
import { MAX_ATTACHMENT_READ_ROOTS } from "../../provider/attachment-read-grant.js";
import { imageMediaType } from "../../provider/provider-image-read.js";

export interface RuntimeAttachmentBroker {
  resolve(
    attachmentId: string,
    handoffId: string,
    signal?: AbortSignal,
  ): Promise<TrustedRuntimeAttachment | null>;
  release(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  cleanup(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  relinquish(
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface ResolvedAttachmentPayload {
  attachment: ChatAttachment;
  bytes: Uint8Array;
  source?: AttachmentFileSource;
}

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function publicAttachmentError(): Error {
  return new AttachmentResolutionError();
}

export class TrustedAttachmentResolver {
  constructor(
    private readonly trustedRoot: string,
    private readonly broker: RuntimeAttachmentBroker,
  ) {}

  async resolveAll(
    requested: readonly ChatAttachment[],
    handoffId: string,
    signal?: AbortSignal,
  ): Promise<ChatAttachment[]> {
    return (await this.resolvePayloads(requested, handoffId, signal))
      .map(({ attachment }) => attachment);
  }

  async resolvePayloads(
    requested: readonly ChatAttachment[],
    handoffId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedAttachmentPayload[]> {
    if (requested.length > MAX_ATTACHMENT_COUNT) throw publicAttachmentError();
    if (requested.length === 0) return [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(handoffId)) throw publicAttachmentError();
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.trustedRoot);
    } catch {
      throw publicAttachmentError();
    }
    const claimedIds: string[] = [];
    try {
      const seenIds = new Set<string>();
      const seenPaths = new Set<string>();
      const resolved: ResolvedAttachmentPayload[] = [];
      let totalBytes = 0;
      for (const untrusted of requested) {
        if (signal?.aborted) throw publicAttachmentError();
        if (seenIds.has(untrusted.id)) throw publicAttachmentError();
        seenIds.add(untrusted.id);
        const trusted = await this.broker.resolve(
          untrusted.id,
          handoffId,
          signal,
        );
        if (!trusted || trusted.id !== untrusted.id) throw publicAttachmentError();
        claimedIds.push(untrusted.id);
        const payload = await this.revalidate(canonicalRoot, trusted, signal);
        const { attachment } = payload;
        if (seenPaths.has(attachment.path)) throw publicAttachmentError();
        seenPaths.add(attachment.path);
        totalBytes += attachment.size;
        if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw publicAttachmentError();
        resolved.push(payload);
      }
      if (attachmentLimitError(resolved.map(({ attachment }) => attachment))) throw publicAttachmentError();
      return resolved;
    } catch (error) {
      await this.relinquishAll(claimedIds);
      throw error;
    }
  }

  async relinquishAll(attachmentIds: readonly string[]): Promise<void> {
    await Promise.allSettled(attachmentIds.map((attachmentId) =>
      this.broker.relinquish(attachmentId)));
  }

  async releaseAll(attachmentIds: readonly string[]): Promise<void> {
    await Promise.allSettled(attachmentIds.map((attachmentId) =>
      this.broker.release(attachmentId)));
  }

  private async revalidate(
    canonicalRoot: string,
    trusted: TrustedRuntimeAttachment,
    signal?: AbortSignal,
  ): Promise<ResolvedAttachmentPayload> {
    try {
      if (
        trusted.size < 1
        || trusted.size > MAX_ATTACHMENT_BYTES
        || !/^[0-9a-f]{64}$/u.test(trusted.digest)
        || !storedAttachmentTypeMatchesName(trusted.name, trusted.mimeType)
      ) throw publicAttachmentError();
      const pathInfo = await lstat(trusted.path);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) throw publicAttachmentError();
      const canonicalPath = await realpath(trusted.path);
      if (
        !isContained(canonicalRoot, canonicalPath)
        || canonicalPath !== trusted.path
        || basename(canonicalPath)
          !== `${trusted.id}.${chatAttachmentStorageExtension(trusted.mimeType)}`
      ) throw publicAttachmentError();
      const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
      const nonBlocking =
        "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
      const file = await open(
        canonicalPath,
        constants.O_RDONLY | noFollow | nonBlocking,
      );
      let bytes: Buffer;
      try {
        const before = await file.stat();
        if (
          !before.isFile()
          || !sameIdentity(pathInfo, before)
          || before.size !== trusted.size
        ) throw publicAttachmentError();
        if (signal?.aborted) throw publicAttachmentError();
        const read = await readAttachment(file, trusted.size, 0, signal);
        bytes = read.bytes;
        const after = await file.stat();
        if (
          signal?.aborted
          || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs
          || read.digest !== trusted.digest
        ) throw publicAttachmentError();
      } finally {
        await file.close();
      }
      return {
        attachment: {
          id: trusted.id,
          name: trusted.name,
          path: canonicalPath,
          mimeType: trusted.mimeType,
          size: trusted.size,
          ...(trusted.snapshot ? { snapshot: snapshotSourceSchema.parse(trusted.snapshot) } : {}),
        },
        bytes,
        source: { path: canonicalPath, digest: trusted.digest },
      };
    } catch {
      throw publicAttachmentError();
    }
  }
}

const RETAINED_ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Checks one missed run's image; null skips it. */
export type MissedRunImageCheck = (input: { attachment: ChatAttachment }) => { path: string; size: number } | null;

/**
 * Opens one turn's check of missed runs' images, resolving the retained folder once (null when it cannot be). Each
 * image is the retained file at its store layout `<retained>/<id>/<id>.<ext>` (never the stored path), resolving
 * inside `<retained>/<id>`, a regular file that is no symlink, nonempty and within the image limit, with an image
 * type and matching extension. A missing or unsafe file is skipped and never fails the send.
 */
export function retainedMissedRunImageCheck(
  retained: { readonly directory: string },
): () => MissedRunImageCheck | null {
  return () => {
    let root: string;
    try { root = realpathSync(retained.directory); } catch { return null; }
    return ({ attachment }) => {
      if (!RETAINED_ATTACHMENT_ID.test(attachment.id) || chatAttachmentKind(attachment.mimeType) !== "image") return null;
      try {
        const folder = join(root, attachment.id);
        const path = join(folder, `${attachment.id}.${chatAttachmentStorageExtension(attachment.mimeType)}`);
        if (imageMediaType(path) !== attachment.mimeType) return null;
        const directory = lstatSync(folder);
        if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink() || file.size <= 0 || file.size > MAX_IMAGE_ATTACHMENT_BYTES) return null;
        const canonicalFolder = realpathSync(folder);
        const canonical = realpathSync(path);
        if (!singleSegmentWithin(root, canonicalFolder) || !singleSegmentWithin(canonicalFolder, canonical)) return null;
        return { path: canonical, size: file.size };
      } catch {
        return null;
      }
    };
  };
}

function singleSegmentWithin(parent: string, child: string): boolean {
  const contained = relative(parent, child);
  return contained !== "" && !contained.startsWith("..") && !isAbsolute(contained) && !contained.includes(sep);
}

export function conversationAttachmentReadRoots(
  store: { attachments(conversationId: string): readonly { readonly id: string }[] },
  retained: { readonly directory: string },
): (input: { conversationId: string; attachmentIds: readonly string[] }) => string[] {
  // The requested ids (the message's own and any carried from missed runs) go last, so the bound never drops them.
  return ({ conversationId, attachmentIds }) => {
    const requested = new Set(attachmentIds);
    return [...new Set([
      ...store.attachments(conversationId).map(({ id }) => id).filter((id) => !requested.has(id)),
      ...requested,
    ])]
      .filter((id) => RETAINED_ATTACHMENT_ID.test(id))
      .slice(-MAX_ATTACHMENT_READ_ROOTS)
      .map((id) => join(retained.directory, id));
  };
}
