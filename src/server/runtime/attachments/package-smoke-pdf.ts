import { readFile, writeFile } from "node:fs/promises";

import { documentAttachmentContexts } from "./document-attachment-context.js";

const PACKAGE_SMOKE_ATTACHMENT_ID = "00000000-0000-4000-8000-000000000017";
const PACKAGE_SMOKE_TEXT = "Packaged PDF extraction works";

export async function runPackagedPdfSmoke(
  inputPath: string,
  resultPath: string,
): Promise<void> {
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
  await writeFile(
    resultPath,
    JSON.stringify({ ok: true, content: context.content }),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}
