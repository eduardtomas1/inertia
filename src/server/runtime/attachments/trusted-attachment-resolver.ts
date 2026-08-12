import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentMimeTypeForName,
  chatAttachmentStorageExtension,
} from "../../../shared/attachments.js";
import type { ChatAttachment } from "../../../shared/contracts.js";
import type { TrustedRuntimeAttachment } from "../../../shared/runtime-attachments.js";
import { AttachmentResolutionError } from "./attachment-errors.js";

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
  private readonly trustedRoot: string;
  private readonly rootAuthority: {
    readonly dev: number;
    readonly ino: number;
    readonly uid: number | null;
  };

  constructor(
    trustedRoot: string,
    private readonly broker: RuntimeAttachmentBroker,
  ) {
    const requested = resolve(trustedRoot);
    const named = lstatSync(requested);
    const canonical = realpathSync(requested);
    if (
      canonical !== requested
      || !named.isDirectory()
      || named.isSymbolicLink()
      || (
        process.platform !== "win32"
        && (
          (named.mode & 0o777) !== 0o700
          || (
            typeof process.getuid === "function"
            && named.uid !== process.getuid()
          )
        )
      )
    ) throw publicAttachmentError();
    this.trustedRoot = canonical;
    this.rootAuthority = {
      dev: named.dev,
      ino: named.ino,
      uid: typeof process.getuid === "function" ? named.uid : null,
    };
  }

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
    if (requested.length > MAX_CHAT_ATTACHMENTS) throw publicAttachmentError();
    if (requested.length === 0) return [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(handoffId)) throw publicAttachmentError();
    const canonicalRoot = await this.assertRootAuthority();
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
        if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) throw publicAttachmentError();
        resolved.push(payload);
      }
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
          !== `${trusted.id}.${chatAttachmentStorageExtension(trusted.mimeType)}`
      ) throw publicAttachmentError();
      const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
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
        bytes = await file.readFile();
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
      await this.assertRootAuthority();
      return {
        attachment: {
          id: trusted.id,
          name: trusted.name,
          path: canonicalPath,
          mimeType: trusted.mimeType,
          size: trusted.size,
        },
        bytes,
      };
    } catch {
      throw publicAttachmentError();
    }
  }

  private async assertRootAuthority(): Promise<string> {
    try {
      const named = await lstat(this.trustedRoot);
      const canonical = await realpath(this.trustedRoot);
      if (
        canonical !== this.trustedRoot
        || !named.isDirectory()
        || named.isSymbolicLink()
        || !sameIdentity(named, this.rootAuthority)
        || (
          process.platform !== "win32"
          && (
            (named.mode & 0o777) !== 0o700
            || (
              this.rootAuthority.uid !== null
              && named.uid !== this.rootAuthority.uid
            )
          )
        )
      ) throw publicAttachmentError();
      return canonical;
    } catch {
      throw publicAttachmentError();
    }
  }
}
