import { PROJECT_ICON_SIZE, MAX_PROJECT_ICON_DATA_LENGTH } from "../../../shared/project-preferences";

/** Accept small raster images only, strip metadata, and persist a bounded PNG. */
export async function readProjectIcon(file: File): Promise<string> {
  if (file.size > 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG or WebP image up to 1 MB.");
  }
  const bitmap = await createImageBitmap(file, { resizeWidth: PROJECT_ICON_SIZE, resizeHeight: PROJECT_ICON_SIZE, resizeQuality: "high" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = PROJECT_ICON_SIZE; canvas.height = PROJECT_ICON_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    context.drawImage(bitmap, 0, 0, PROJECT_ICON_SIZE, PROJECT_ICON_SIZE);
    const result = canvas.toDataURL("image/png");
    if (result.length > MAX_PROJECT_ICON_DATA_LENGTH) throw new Error("The icon is too large. Choose a simpler image.");
    return result;
  } finally { bitmap.close(); }
}
