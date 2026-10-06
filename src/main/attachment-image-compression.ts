import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_SOURCE_IMAGE_BYTES, type ImageAttachmentMimeType } from "../shared/attachments.js";
import { inspectImageMetadata, MAX_IMAGE_PIXELS } from "./attachment-image-validation.js";

export async function compressAttachmentImage(bytes: Buffer, mimeType: ImageAttachmentMimeType): Promise<Buffer | null> {
  if (bytes.length > MAX_SOURCE_IMAGE_BYTES) throw new Error("Source images must be at most 50 MiB.");
  const metadata = inspectImageMetadata(bytes, mimeType);
  if (!metadata || metadata.width * metadata.height * metadata.frames > MAX_IMAGE_PIXELS) {
    return null;
  }
  if (bytes.length <= MAX_IMAGE_ATTACHMENT_BYTES && metadata.width <= 8192 && metadata.height <= 8192) return null;
  const { createCanvas, Image } = await import("@napi-rs/canvas");
  const image = new Image();
  image.src = bytes;
  await image.decode();
  const initialScale = Math.min(1, 8192 / image.width, 8192 / image.height);
  for (const scale of [1, 0.75, 0.55, 0.4]) {
    const canvas = createCanvas(Math.max(1, Math.floor(image.width * initialScale * scale)), Math.max(1, Math.floor(image.height * initialScale * scale)));
    const context = canvas.getContext("2d");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [92, 85, 78, 68]) {
      const encoded = await canvas.encode("jpeg", quality);
      if (encoded.length <= MAX_IMAGE_ATTACHMENT_BYTES) return encoded;
    }
  }
  throw new Error("This image could not be resized to fit within 10 MiB.");
}
