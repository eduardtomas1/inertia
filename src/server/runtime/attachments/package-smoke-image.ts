import { readFile, writeFile } from "node:fs/promises";

import type { ConversationAttachmentStore } from "../../../node/conversation-attachment-store.js";

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
    await writeFile(resultPath, JSON.stringify({ ok: true }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      signal,
    });
  } catch (error) {
    await writeFile(resultPath, JSON.stringify({
      ok: false,
      message: error instanceof Error ? error.message : "Image retention failed.",
    }), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    }).catch(() => undefined);
    throw error;
  }
}
