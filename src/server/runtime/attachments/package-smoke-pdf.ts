import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { documentAttachmentContexts } from "./document-attachment-context.js";

const PACKAGE_SMOKE_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000017";
const PACKAGE_SMOKE_TEXT = "Packaged PDF extraction works";

export type PackagedPdfSmokeResult =
  | { ok: true; content: string }
  | { ok: false; message: string };

interface PackagedPdfSmokeFileOperations {
  open: typeof open;
  rename: typeof rename;
}

interface PackagedPdfSmokeWriteOptions {
  readonly signal?: AbortSignal;
  readonly operations?: Partial<PackagedPdfSmokeFileOperations>;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

export async function writePackagedPdfSmokeResult(
  resultPath: string,
  result: PackagedPdfSmokeResult,
  options: PackagedPdfSmokeWriteOptions = {},
): Promise<void> {
  const partialPath = join(
    dirname(resultPath),
    `.inertia-package-smoke-${randomUUID()}.partial`,
  );
  const openFile = options.operations?.open ?? open;
  const renameFile = options.operations?.rename ?? rename;
  let file: FileHandle | null = null;
  let published = false;
  let primaryError: unknown;
  try {
    throwIfAborted(options.signal);
    file = await openFile(
      partialPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await file.writeFile(JSON.stringify(result), {
      encoding: "utf8",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await file.sync();
    await file.close();
    file = null;
    throwIfAborted(options.signal);
    await renameFile(partialPath, resultPath);
    published = true;
  } catch (error) {
    primaryError = error;
  } finally {
    if (file) {
      try {
        await file.close();
      } catch (closeError) {
        primaryError ??= closeError;
      }
    }
    if (!published) await unlink(partialPath).catch(() => undefined);
  }
  if (primaryError !== undefined) throw primaryError;
}

export async function runPackagedPdfSmoke(
  inputPath: string,
  resultPath: string,
  signal?: AbortSignal,
): Promise<void> {
  let result: PackagedPdfSmokeResult;
  let failure: unknown;
  try {
    const bytes = await readFile(inputPath);
    const [context] = await documentAttachmentContexts([{
      attachment: {
        id: PACKAGE_SMOKE_ATTACHMENT_ID,
        name: "package-smoke.pdf",
        path: inputPath,
        mimeType: "application/pdf",
        size: bytes.byteLength,
      },
      bytes,
    }], { signal });
    if (
      !context
      || context.label !== "PDF · package-smoke.pdf"
      || !context.content.includes(PACKAGE_SMOKE_TEXT)
    ) {
      throw new Error("The packaged PDF stack returned unexpected text.");
    }
    result = { ok: true, content: context.content };
  } catch (error) {
    failure = error;
    const detail = error instanceof Error
      ? error.message.trim().replace(/\s+/gu, " ").slice(0, 800)
      : "";
    result = {
      ok: false,
      message: detail || "The packaged PDF stack failed.",
    };
  }
  await writePackagedPdfSmokeResult(
    resultPath,
    result,
    { signal },
  );
  if (failure !== undefined) throw failure;
}
