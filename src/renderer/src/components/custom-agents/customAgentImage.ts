import { CUSTOM_AGENT_ICON_SIZE, MAX_CUSTOM_AGENT_ICON_DATA_LENGTH } from "@shared/custom-agents";

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_SOURCE_BYTES = 1024 * 1024;
const FALLBACK_SIZES = [CUSTOM_AGENT_ICON_SIZE, 48, 32] as const;

export const CUSTOM_AGENT_IMAGE_ACCEPT = ACCEPTED_TYPES.join(",");

function encode(bitmap: ImageBitmap, size: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image processing is unavailable.");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, size, size);
  return canvas.toDataURL("image/png");
}

export async function readCustomAgentIcon(file: File): Promise<string> {
  if (file.size > MAX_SOURCE_BYTES || !ACCEPTED_TYPES.includes(file.type)) {
    throw new Error("Choose a PNG, JPEG or WebP image up to 1 MB.");
  }
  const bitmap = await createImageBitmap(file, {
    resizeWidth: CUSTOM_AGENT_ICON_SIZE,
    resizeHeight: CUSTOM_AGENT_ICON_SIZE,
    resizeQuality: "high",
  });
  try {
    for (const size of FALLBACK_SIZES) {
      const result = encode(bitmap, size);
      if (result.startsWith("data:image/png;base64,") && result.length <= MAX_CUSTOM_AGENT_ICON_DATA_LENGTH) return result;
    }
    throw new Error("The image is too detailed for an icon. Choose a simpler one.");
  } finally {
    bitmap.close();
  }
}
