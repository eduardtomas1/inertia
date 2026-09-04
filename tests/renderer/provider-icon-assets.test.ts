import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const assetDirectory = join(
  process.cwd(),
  "src",
  "renderer",
  "src",
  "assets",
  "provider-icons",
);

const assetDigests = {
  "anthropic.svg": "7e78883e38ac9a21881a900bcfad4ac91d04dd0db27ceed7ed8d8590dc174674",
  "cursor-dark.svg": "c4be4f61e5fcc666e8c62f20d7b894e7c235f867b9724b982be660a2d24b6916",
  "cursor-light.svg": "68ade1cd692678d00087a72058992ab7d29ff5e4efe565dbef2cf973fd24df1d",
  "gemini.svg": "9e015cb9e3718f5245ef8ac3359a858ba94cd239817c70c3a99b6b3146948731",
  "openai.svg": "0dd4dd71846aeb7a484acdc59eb08eac2b3c1264a143d11bca9b73e4a8cacfbf",
  "opencode-dark.svg": "8837185c28ba4a9ed1374af574eea6f9da7bcc81dd1a5dca848400e10cf8fef8",
  "opencode-light.svg": "c7d5808526b9a9dcfd9e49cf3baffa115f567b005f8fc186062851acc1ac1437",
} as const;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => (
    Number.parseInt(hex.slice(offset, offset + 2), 16)
  ));
  return 0.2126 * channelLuminance(channels[0]!)
    + 0.7152 * channelLuminance(channels[1]!)
    + 0.0722 * channelLuminance(channels[2]!);
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe("provider icon assets", () => {
  it("preserves reviewed SVG bytes across Git checkouts", () => {
    const attributes = readFileSync(join(process.cwd(), ".gitattributes"), "utf8")
      .split(/\r?\n/u);
    expect(attributes).toContain(
      "src/renderer/src/assets/provider-icons/*.svg binary",
    );
  });

  it("keeps the reviewed official vector geometry intact", () => {
    for (const [fileName, expectedDigest] of Object.entries(assetDigests)) {
      const asset = readFileSync(join(assetDirectory, fileName));
      const digest = createHash("sha256").update(asset).digest("hex");
      expect(digest, fileName).toBe(expectedDigest);
    }
  });

  it("keeps each supplied mark distinguishable in light and dark themes", () => {
    const contrastPairs = [
      ["OpenAI light", "#000000", "#f1f1f3"],
      ["OpenAI dark", "#ffffff", "#09090b"],
      ["Anthropic light backing", "#D97757", "#ffffff"],
      ["Anthropic dark", "#D97757", "#09090b"],
      ["Cursor light", "#26251e", "#f1f1f3"],
      ["Cursor dark", "#edecec", "#09090b"],
      ["OpenCode light", "#17181C", "#FDFCFC"],
      ["OpenCode dark", "#ffffff", "#131010"],
    ] as const;

    for (const [label, foreground, background] of contrastPairs) {
      expect(contrastRatio(foreground, background), label)
        .toBeGreaterThanOrEqual(3);
    }
  });
});
