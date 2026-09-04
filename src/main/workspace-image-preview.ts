import { constants, type Stats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../node/platform-file-open-flags.js";
import type { OpenProjectPathRequest } from "../shared/desktop.js";
import {
  MAX_WORKSPACE_IMAGE_PREVIEW_BYTES,
} from "../shared/workspace-image-preview.js";
import { inspectWorkspaceImageMetadata } from "./workspace-image-metadata.js";

interface ProjectPathResolver {
  resolveProjectPath(request: OpenProjectPathRequest): Promise<string>;
}

interface WeightedWaiter {
  bytes: number;
  resolve: (release: () => void) => void;
}

interface PreparedWorkspaceImage {
  handle: FileHandle;
  info: Stats;
  mimeType: string;
  releaseBudget: () => void;
}

export const MAX_ACTIVE_WORKSPACE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ACTIVE_WORKSPACE_IMAGE_STREAMS = 32;
const MAX_PENDING_WORKSPACE_IMAGE_READS = 32;
const WORKSPACE_IMAGE_STREAM_CHUNK_BYTES = 64 * 1024;
let activeWorkspaceImageBytes = 0;
let activeWorkspaceImageStreams = 0;
const workspaceImageWaiters: WeightedWaiter[] = [];

function drainWorkspaceImageWaiters(): void {
  while (workspaceImageWaiters.length > 0) {
    const next = workspaceImageWaiters[0]!;
    if (
      activeWorkspaceImageStreams >= MAX_ACTIVE_WORKSPACE_IMAGE_STREAMS
      || activeWorkspaceImageBytes + next.bytes > MAX_ACTIVE_WORKSPACE_IMAGE_BYTES
    ) return;
    workspaceImageWaiters.shift();
    activeWorkspaceImageBytes += next.bytes;
    activeWorkspaceImageStreams += 1;
    next.resolve(releaseWorkspaceImageBytes(next.bytes));
  }
}

function releaseWorkspaceImageBytes(bytes: number): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWorkspaceImageBytes -= bytes;
    activeWorkspaceImageStreams -= 1;
    drainWorkspaceImageWaiters();
  };
}

function assertWorkspaceImageRequestActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("The workspace image request was cancelled.");
  }
}

async function acquireWorkspaceImageBytes(
  bytes: number,
  signal?: AbortSignal,
): Promise<() => void> {
  assertWorkspaceImageRequestActive(signal);
  if (bytes <= 0 || bytes > MAX_ACTIVE_WORKSPACE_IMAGE_BYTES) {
    throw new Error("The workspace image exceeds the active byte budget.");
  }
  if (
    workspaceImageWaiters.length === 0
    && activeWorkspaceImageStreams < MAX_ACTIVE_WORKSPACE_IMAGE_STREAMS
    && activeWorkspaceImageBytes + bytes <= MAX_ACTIVE_WORKSPACE_IMAGE_BYTES
  ) {
    activeWorkspaceImageBytes += bytes;
    activeWorkspaceImageStreams += 1;
    return releaseWorkspaceImageBytes(bytes);
  }
  if (workspaceImageWaiters.length >= MAX_PENDING_WORKSPACE_IMAGE_READS) {
    throw new Error("Too many workspace images are waiting to load.");
  }
  return await new Promise<() => void>((resolvePermit, rejectPermit) => {
    let waiter: WeightedWaiter;
    const removeAbortListener = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      const index = workspaceImageWaiters.indexOf(waiter);
      if (index >= 0) workspaceImageWaiters.splice(index, 1);
      removeAbortListener();
      rejectPermit(new Error("The workspace image request was cancelled."));
      drainWorkspaceImageWaiters();
    };
    waiter = {
      bytes,
      resolve: (release) => {
        removeAbortListener();
        resolvePermit(release);
      },
    };
    workspaceImageWaiters.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US")
      === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function hasSameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function verifyOpenImageIdentity(
  handle: FileHandle,
  expected: Stats,
): Promise<void> {
  if (!hasSameIdentity(expected, await handle.stat())) {
    throw new Error("The workspace image identity changed.");
  }
}

async function prepareWorkspaceImage(
  path: string,
  signal?: AbortSignal,
): Promise<PreparedWorkspaceImage> {
  assertWorkspaceImageRequestActive(signal);
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  let releaseBudget: (() => void) | null = null;
  try {
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.size <= 0
      || info.size > MAX_WORKSPACE_IMAGE_PREVIEW_BYTES
    ) throw new Error("The workspace image is not a bounded regular file.");

    const canonical = await realpath(path);
    if (!samePath(canonical, path)) {
      throw new Error("The workspace image changed after path validation.");
    }
    if (!hasSameIdentity(info, await stat(canonical))) {
      throw new Error("The workspace image identity changed.");
    }

    releaseBudget = await acquireWorkspaceImageBytes(info.size, signal);
    assertWorkspaceImageRequestActive(signal);
    const { mimeType } = await inspectWorkspaceImageMetadata(handle, info.size);
    assertWorkspaceImageRequestActive(signal);
    await verifyOpenImageIdentity(handle, info);
    return { handle, info, mimeType, releaseBudget };
  } catch (error) {
    try {
      await handle.close();
    } finally {
      releaseBudget?.();
    }
    throw error;
  }
}

function workspaceImageStream(
  image: PreparedWorkspaceImage,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let disposed = false;
  let removeAbortListener = (): void => undefined;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    removeAbortListener();
    try {
      await image.handle.close();
    } finally {
      image.releaseBudget();
    }
  };
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const abort = (): void => {
        controller.error(new Error("The workspace image request was cancelled."));
        void dispose();
      };
      removeAbortListener = (): void => {
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    },
    pull: async (controller) => {
      try {
        // Close on the pull after the final chunk. This keeps the weighted
        // lease until the consumer drains the response body rather than only
        // until the source has queued its last bytes.
        if (offset === image.info.size) {
          await verifyOpenImageIdentity(image.handle, image.info);
          controller.close();
          await dispose();
          return;
        }
        const buffer = Buffer.allocUnsafe(Math.min(
          WORKSPACE_IMAGE_STREAM_CHUNK_BYTES,
          image.info.size - offset,
        ));
        const { bytesRead } = await image.handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (bytesRead <= 0) throw new Error("The workspace image changed while streaming.");
        offset += bytesRead;
        controller.enqueue(bytesRead === buffer.length
          ? buffer
          : buffer.subarray(0, bytesRead));
      } catch (error) {
        try {
          controller.error(error);
        } finally {
          await dispose();
        }
      }
    },
    cancel: dispose,
  }, { highWaterMark: 1 });
}

export async function resolveWorkspaceImagePreviewResponse(
  resolver: ProjectPathResolver,
  request: OpenProjectPathRequest,
  signal?: AbortSignal,
): Promise<Response> {
  assertWorkspaceImageRequestActive(signal);
  const path = await resolver.resolveProjectPath(request);
  assertWorkspaceImageRequestActive(signal);
  const image = await prepareWorkspaceImage(path, signal);
  try {
    return new Response(workspaceImageStream(image, signal), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Length": String(image.info.size),
        "Content-Type": image.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    try {
      await image.handle.close();
    } finally {
      image.releaseBudget();
    }
    throw error;
  }
}
