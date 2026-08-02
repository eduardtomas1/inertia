import { readFile, writeFile } from "node:fs/promises";

import { documentAttachmentContexts } from "./document-attachment-context.js";

const PACKAGE_SMOKE_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000017";
const PACKAGE_SMOKE_TEXT = "Packaged PDF extraction works";

export async function runPackagedPdfSmoke(
  inputPath: string,
  resultPath: string,
): Promise<void> {
  let result: { ok: true; content: string } | { ok: false; message: string };
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
    }]);
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
  await writeFile(
    resultPath,
    JSON.stringify(result),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  if (failure !== undefined) throw failure;
}
