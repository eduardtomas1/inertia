import { execFileSync } from "node:child_process";

export interface CanvasEnvironmentProbe {
  readonly families: number;
  readonly decoded: readonly [number, number];
  readonly reencoded: readonly [number, number];
}

export function probeCanvasInEnvironment(
  env: Record<string, string>,
): CanvasEnvironmentProbe {
  return JSON.parse(execFileSync(process.execPath, ["-e", `
    const { GlobalFonts, Image, createCanvas } = require("@napi-rs/canvas");
    const decode = async (bytes) => {
      const image = new Image();
      image.src = bytes;
      await image.decode();
      return image;
    };
    void (async () => {
      const source = createCanvas(1920, 1080);
      source.getContext("2d").fillRect(120, 160, 800, 440);
      const decoded = await decode(source.encodeSync("png"));
      const copy = createCanvas(decoded.width, decoded.height);
      copy.getContext("2d").drawImage(decoded, 0, 0);
      const reencoded = await decode(copy.encodeSync("png"));
      process.stdout.write(JSON.stringify({
        families: GlobalFonts.families.length,
        decoded: [decoded.width, decoded.height],
        reencoded: [reencoded.width, reencoded.height],
      }));
    })();
  `], { env, encoding: "utf8", timeout: 30_000 })) as CanvasEnvironmentProbe;
}
