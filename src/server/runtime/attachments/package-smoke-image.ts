import { readFile } from "node:fs/promises";

import type { ConversationAttachmentStore } from "../../../node/conversation-attachment-store.js";
import { writePackagedSmokeResult } from "./package-smoke-pdf.js";

const PACKAGE_SMOKE_IMAGE_ID = "00000000-0000-4000-8000-000000000018";
const PACKAGE_SMOKE_RETENTION_ID = "00000000-0000-4000-8000-000000000019";

export async function runPackagedImageRetentionSmoke(
  inputPath: string,
  resultPath: string,
  store: ConversationAttachmentStore,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const bytes = await readFile(inputPath, { signal });
    const [retained] = await store.retain([{
      attachment: {
        id: PACKAGE_SMOKE_IMAGE_ID,
        name: "package-smoke.png",
        path: inputPath,
        mimeType: "image/png",
        size: bytes.byteLength,
      },
      bytes,
    }], signal, PACKAGE_SMOKE_RETENTION_ID);
    const preview = retained
      ? await store.preview(retained.id)
      : null;
    if (!preview || !Buffer.from(preview.bytes).equals(bytes)) {
      throw new Error("The packaged image retention path returned invalid bytes.");
    }
    store.acceptRetention(PACKAGE_SMOKE_RETENTION_ID);
    await writePackagedSmokeResult(resultPath, { ok: true }, { signal });
  } catch (error) {
    await writePackagedSmokeResult(resultPath, {
      ok: false,
      message: error instanceof Error ? error.message : "Image retention failed.",
    }).catch(() => undefined);
    throw error;
  }
}
