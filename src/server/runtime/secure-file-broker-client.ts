import { randomUUID } from "node:crypto";
import {
  lstat,
  realpath,
} from "node:fs/promises";
import { resolve } from "node:path";

import type {
  RuntimeSecureFileResult,
  RuntimeWorkerEvent,
} from "../../node/runtime-process-protocol.js";
import type {
  SecureFileIdentity,
  SecureFileRequest,
} from "../../node/secure-file-protocol.js";
import { secureFilePathSegments } from "../../node/secure-file-protocol.js";
import type {
  RuntimeSecureFileBroker,
  SecureFileRead,
  SecureFileReplace,
  SecureFileRootCapability,
} from "../secure-files.js";
import { SecureFileError } from "../secure-files.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_PENDING_REQUESTS = 64;

interface PendingRequest {
  operation: SecureFileRequest["operation"];
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (value: SecureFileRead | SecureFileReplace | undefined) => void;
  reject: (error: Error) => void;
}

function unavailable(message = "The secure file operation could not be completed."): Error {
  return new SecureFileError("unavailable", message);
}

function missingPath(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

export class RuntimeSecureFileBrokerClient implements RuntimeSecureFileBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly post: (event: RuntimeWorkerEvent) => void,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.timeoutMs = Math.max(1, Math.min(Math.trunc(timeoutMs), 30_000));
  }

  async read(
    root: SecureFileRootCapability,
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SecureFileRead> {
    const authority = await this.authority(root, path, signal);
    return await this.request({
      operation: "read",
      ...authority,
      path,
      maxBytes,
    }, signal) as SecureFileRead;
  }

  async replace(
    root: SecureFileRootCapability,
    path: string,
    content: Buffer,
    expectedDigest: string,
    expectedMode: number,
    mode: number,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<SecureFileReplace> {
    const authority = await this.authority(root, path, signal);
    return await this.request({
      operation: "replace",
      ...authority,
      path,
      maxBytes,
      expectedDigest,
      contentBase64: content.toString("base64"),
      expectedMode: expectedMode & 0o777,
      mode: mode & 0o777,
    }, signal) as SecureFileReplace;
  }

  async authorizeRoot(
    root: string,
    signal?: AbortSignal,
  ): Promise<SecureFileRootCapability> {
    if (this.closed || signal?.aborted) throw unavailable();
    const canonicalRoot = await realpath(root);
    const rootInfo = await lstat(canonicalRoot, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new SecureFileError(
        "unsafe",
        "The secure file root is no longer a safe directory.",
      );
    }
    return {
      root: canonicalRoot,
      identity: this.identity(rootInfo),
    };
  }

  async verifyRoot(
    root: SecureFileRootCapability,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.closed || signal?.aborted) throw unavailable();
    const rootInfo = await lstat(root.root, { bigint: true });
    if (
      !rootInfo.isDirectory()
      || rootInfo.isSymbolicLink()
      || !this.sameIdentity(this.identity(rootInfo), root.identity)
    ) {
      throw new SecureFileError(
        "unsafe",
        "The secure file root changed after it was authorized.",
      );
    }
  }

  handle(result: RuntimeSecureFileResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending) return false;
    this.pending.delete(result.requestId);
    this.cleanup(pending);
    if (!result.result.ok) {
      pending.reject(new SecureFileError(
        result.result.code,
        result.result.message,
      ));
      return true;
    }
    if (result.result.operation !== pending.operation) {
      pending.reject(unavailable());
      return true;
    }
    if (result.result.operation === "recover") {
      pending.resolve(undefined);
    } else if (result.result.operation === "read") {
      pending.resolve({
        content: Buffer.from(result.result.contentBase64, "base64"),
        ...result.result.metadata,
      });
    } else {
      pending.resolve(result.result.metadata);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.cleanup(pending);
      pending.reject(unavailable("The secure file service stopped."));
    }
  }

  private async authority(
    root: SecureFileRootCapability,
    path: string,
    signal?: AbortSignal,
  ): Promise<{
    root: string;
    rootIdentity: SecureFileIdentity;
    parentIdentities: SecureFileIdentity[];
    targetIdentity: SecureFileIdentity;
  }> {
    const segments = secureFilePathSegments(path);
    if (!segments) {
      throw new SecureFileError(
        "invalid",
        "The secure file path was invalid.",
      );
    }
    await this.verifyRoot(root);
    const basename = segments.pop();
    if (!basename) throw unavailable();
    const parentIdentities: SecureFileIdentity[] = [];
    let cursor = root.root;
    for (const segment of segments) {
      cursor = resolve(cursor, segment);
      const info = await lstat(cursor, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      parentIdentities.push(this.identity(info));
    }
    const targetPath = resolve(cursor, basename);
    let target = await lstat(targetPath, { bigint: true }).catch((error) => {
      if (missingPath(error)) return null;
      throw error;
    });
    if (!target) {
      await this.request({
        operation: "recover",
        root: root.root,
        rootIdentity: root.identity,
        parentIdentities,
        path,
      }, signal);
      target = await lstat(targetPath, { bigint: true }).catch((error) => {
        if (missingPath(error)) return null;
        throw error;
      });
    }
    if (!target) {
      throw new SecureFileError(
        "not-found",
        "The selected file is missing.",
      );
    }
    if (!target.isFile() || target.isSymbolicLink()) throw unavailable();
    return {
      root: root.root,
      rootIdentity: root.identity,
      parentIdentities,
      targetIdentity: this.identity(target),
    };
  }

  private identity(
    info: { dev: bigint; ino: bigint },
  ): SecureFileIdentity {
    if (info.ino <= 0n || info.dev < 0n) throw unavailable();
    return {
      dev: info.dev.toString(10),
      ino: info.ino.toString(10),
    };
  }

  private sameIdentity(
    left: SecureFileIdentity,
    right: SecureFileIdentity,
  ): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  private async request(
    request: SecureFileRequest,
    signal?: AbortSignal,
  ): Promise<SecureFileRead | SecureFileReplace | undefined> {
    if (
      this.closed
      || signal?.aborted
      || this.pending.size >= MAX_PENDING_REQUESTS
    ) throw unavailable();
    let requestId = randomUUID();
    while (this.pending.has(requestId)) requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        operation: request.operation,
        timer: setTimeout(() => {
          if (this.pending.get(requestId) !== pending) return;
          this.pending.delete(requestId);
          this.cleanup(pending);
          reject(unavailable("The secure file operation timed out."));
        }, this.timeoutMs),
        signal,
        onAbort: null,
        resolve,
        reject,
      };
      pending.timer.unref();
      if (signal) {
        pending.onAbort = () => {
          if (this.pending.get(requestId) !== pending) return;
          this.pending.delete(requestId);
          this.cleanup(pending);
          reject(unavailable("The secure file operation was cancelled."));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(requestId, pending);
      try {
        this.post({
          type: "runtime.secure-file-request",
          requestId,
          ...request,
        });
      } catch {
        this.pending.delete(requestId);
        this.cleanup(pending);
        reject(unavailable());
      }
    });
  }

  private cleanup(pending: PendingRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}
