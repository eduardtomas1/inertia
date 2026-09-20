import { extname } from "node:path";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ProviderSteerInput } from "./contracts";
import { readBoundedProviderImage, throwIfProviderImageAborted } from "./provider-image-read";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PROMPT_RESERVATION_OVERHEAD_BYTES = 4 * 1024;

export async function claudePrompt(
  prompt: string,
  imagePaths: readonly string[],
  signal?: AbortSignal,
): Promise<SDKUserMessage> {
  throwIfProviderImageAborted("Claude", signal);
  const images: Array<{ data: Buffer; mediaType: NonNullable<ReturnType<typeof imageMediaType>> }> = [];
  let imageBytes = 0;
  for (const path of imagePaths) {
    const mediaType = imageMediaType(path);
    if (!mediaType) {
      throw new Error(
        `Claude does not support the attached image type: ${extname(path) || "unknown"}.`,
      );
    }
    const data = await readBoundedProviderImage("Claude", path, imageBytes, signal);
    imageBytes += data.byteLength;
    images.push({ data, mediaType });
  }
  throwIfProviderImageAborted("Claude", signal);
  const content: Array<Record<string, unknown>> = images.map(
    ({ data, mediaType }) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: data.toString("base64"),
      },
    }),
  );
  content.push({ type: "text", text: prompt });
  return {
    type: "user",
    message: {
      role: "user",
      content,
    } as unknown as SDKUserMessage["message"],
    parent_tool_use_id: null,
  };
}

export function normalizedClaudeFollowUp(
  content: ProviderSteerInput["content"],
): string {
  return content.replaceAll("\0", "").trim();
}

export function claudePromptReservationBytes(
  prompt: string,
  hasImages: boolean,
): number {
  const maximumBase64ImageBytes = hasImages
    ? 4 * Math.ceil(MAX_IMAGE_BYTES / 3)
    : 0;
  return Buffer.byteLength(prompt, "utf8")
    + maximumBase64ImageBytes
    + PROMPT_RESERVATION_OVERHEAD_BYTES;
}

function imageMediaType(
  path: string,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}
