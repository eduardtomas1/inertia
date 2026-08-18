import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveWorkspaceImagePreviewResponse } from "../../src/main/workspace-image-preview";
import { resolveWorkspacePathForOpen } from "../../src/server/workspace";
import {
  MAX_WORKSPACE_IMAGE_PREVIEW_BYTES,
  parseWorkspaceImagePreviewUrl,
  workspaceImagePreviewUrl,
} from "../../src/shared/workspace-image-preview";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const temporaryDirectories: string[] = [];
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pngChunk(kind: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(kind, "ascii"), data, Buffer.alloc(4)]);
}

function pngFixture(options: {
  width?: number;
  height?: number;
  totalBytes?: number;
} = {}): Buffer {
  const width = options.width ?? 1;
  const height = options.height ?? 1;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fixedBytes = signature.length + 25 + 12 + 12;
  const imageDataBytes = Math.max(1, (options.totalBytes ?? fixedBytes + 1) - fixedBytes);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.alloc(imageDataBytes)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegFixture(width = 1, height = 1): Buffer {
  const frame = Buffer.alloc(9);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 1;
  frame.set([1, 0x11, 0], 6);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11]),
    frame,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function gifFixture(frames: number, width = 1, height = 1): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  const frame = Buffer.from([
    0x2c,
    0, 0, 0, 0,
    width & 0xff, width >> 8,
    height & 0xff, height >> 8,
    0,
    2,
    2, 0x44, 0x01, 0,
  ]);
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    screen,
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

function webpLosslessPayload(width = 1, height = 1): Buffer {
  const dimensions = (width - 1) | ((height - 1) << 14);
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE(dimensions, 1);
  return payload;
}

function webpLossyPayload(width = 1, height = 1): Buffer {
  const payload = Buffer.alloc(10);
  payload.set([0x9d, 0x01, 0x2a], 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return payload;
}

function webpChunk(kind: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([
    Buffer.from(kind, "ascii"),
    length,
    data,
    ...(data.length % 2 === 0 ? [] : [Buffer.alloc(1)]),
  ]);
}

function webpContainer(chunks: Buffer[]): Buffer {
  const contents = Buffer.concat(chunks);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(4 + contents.length);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    riffSize,
    Buffer.from("WEBP", "ascii"),
    contents,
  ]);
}

function webpFixture(width = 1, height = 1): Buffer {
  return webpContainer([webpChunk("VP8L", webpLosslessPayload(width, height))]);
}

function uint24LittleEndian(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

function webpExtendedHeader(width: number, height: number, animated: boolean): Buffer {
  return Buffer.concat([
    Buffer.from([animated ? 0x02 : 0, 0, 0, 0]),
    uint24LittleEndian(width - 1),
    uint24LittleEndian(height - 1),
  ]);
}

function webpAnimationFrame(
  frameWidth: number,
  frameHeight: number,
  intrinsicWidth = frameWidth,
  intrinsicHeight = frameHeight,
): Buffer {
  return Buffer.concat([
    Buffer.alloc(6),
    uint24LittleEndian(frameWidth - 1),
    uint24LittleEndian(frameHeight - 1),
    Buffer.alloc(4),
    webpChunk(
      "VP8L",
      webpLosslessPayload(intrinsicWidth, intrinsicHeight),
    ),
  ]);
}

function animatedWebpFixture(frames: number, width = 1, height = 1): Buffer {
  const frame = webpAnimationFrame(width, height);
  return webpContainer([
    webpChunk("VP8X", webpExtendedHeader(width, height, true)),
    webpChunk("ANIM", Buffer.alloc(6)),
    ...Array.from({ length: frames }, () => webpChunk("ANMF", frame)),
  ]);
}

function apngFixture(frames: number, declaredFrames = frames): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(declaredFrames, 0);
  let sequence = 0;
  const frameControl = (): Buffer => {
    const control = Buffer.alloc(26);
    control.writeUInt32BE(sequence, 0);
    sequence += 1;
    control.writeUInt32BE(1, 4);
    control.writeUInt32BE(1, 8);
    return pngChunk("fcTL", control);
  };
  const chunks = [
    pngChunk("IHDR", header),
    pngChunk("acTL", animation),
    frameControl(),
    pngChunk("IDAT", Buffer.from([0])),
  ];
  for (let frame = 1; frame < frames; frame += 1) {
    chunks.push(frameControl());
    const data = Buffer.alloc(5);
    data.writeUInt32BE(sequence, 0);
    sequence += 1;
    chunks.push(pngChunk("fdAT", data));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function adversarialGifExtensions(extensions: number): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(1, 0);
  screen.writeUInt16LE(1, 2);
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    screen,
    ...Array.from({ length: extensions }, () =>
      Buffer.from([0x21, 0xfe, 1, 0x41, 0])),
    gifFixture(1).subarray(13),
  ]);
}

function gifDataSubBlocks(options: {
  blocks?: number;
  payloadBytes?: number;
  terminate?: boolean;
}): Buffer {
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(1, 0);
  screen.writeUInt16LE(1, 2);
  const descriptor = Buffer.from([
    0x2c,
    0, 0, 0, 0,
    1, 0, 1, 0,
    0,
    2,
  ]);
  const subBlocks: Buffer[] = [];
  if (options.payloadBytes !== undefined) {
    let remaining = options.payloadBytes;
    while (remaining > 0) {
      const length = Math.min(255, remaining);
      subBlocks.push(Buffer.concat([
        Buffer.from([length]),
        Buffer.alloc(length),
      ]));
      remaining -= length;
    }
  } else {
    for (let block = 0; block < (options.blocks ?? 0); block += 1) {
      subBlocks.push(Buffer.from([1, 0]));
    }
  }
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    screen,
    descriptor,
    ...subBlocks,
    ...(options.terminate === false
      ? []
      : [Buffer.from([0, 0x3b])]),
  ]);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-workspace-image-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for image reads.");
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function request(relativePath: string) {
  return {
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    relativePath,
    action: "open-externally" as const,
  };
}

describe("workspace image previews", () => {
  it("round-trips a workspace-relative URL without query or file privileges", () => {
    const url = workspaceImagePreviewUrl({
      projectId: PROJECT_ID,
      conversationId: CONVERSATION_ID,
      relativePath: "docs/assets/diagram one.png",
    });
    expect(url).toBe(
      "inertia://bundle/workspace-image/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/docs%2Fassets%2Fdiagram%20one.png",
    );
    expect(parseWorkspaceImagePreviewUrl(new URL(url))).toEqual(
      request("docs/assets/diagram one.png"),
    );
    expect(parseWorkspaceImagePreviewUrl(new URL(
      workspaceImagePreviewUrl({
        projectId: PROJECT_ID,
        relativePath: "images/project.png",
      }),
    ))).toEqual({
      projectId: PROJECT_ID,
      relativePath: "images/project.png",
      action: "open-externally",
    });
    expect(parseWorkspaceImagePreviewUrl(new URL(
      `inertia://bundle/workspace-image/${PROJECT_ID}/project/..%2Fsecret.png`,
    ))).toBeNull();
  });

  it("serves only MIME-sniffed bounded image bytes from the contained resolver", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "project");
    await mkdir(join(root, "docs"), { recursive: true });
    const png = VALID_PNG;
    await writeFile(join(root, "docs", "diagram.bin"), png);
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        (await resolveWorkspacePathForOpen(root, relativePath)).absolute,
    };

    const response = await resolveWorkspaceImagePreviewResponse(
      resolver,
      request("docs/diagram.bin"),
    );
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Length")).toBe(String(png.length));
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);

    await writeFile(join(root, "docs", "not-image.png"), "plain text");
    await expect(resolveWorkspaceImagePreviewResponse(
      resolver,
      request("docs/not-image.png"),
    )).rejects.toThrow("not a supported image");

    await writeFile(
      join(root, "docs", "too-large.png"),
      Buffer.alloc(MAX_WORKSPACE_IMAGE_PREVIEW_BYTES + 1, 0x89),
    );
    await expect(resolveWorkspaceImagePreviewResponse(
      resolver,
      request("docs/too-large.png"),
    )).rejects.toThrow("bounded regular file");
  });

  it("inherits canonical workspace containment and rejects symlink escapes", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "project");
    const outside = join(directory, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    await writeFile(
      join(outside, "secret.png"),
      VALID_PNG,
    );
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        (await resolveWorkspacePathForOpen(root, relativePath)).absolute,
    };

    await expect(resolveWorkspaceImagePreviewResponse(
      resolver,
      request("escape/secret.png"),
    )).rejects.toMatchObject({ code: "outside-workspace" });
  });

  it("recognizes structurally bounded JPEG, GIF, and WebP resources", async () => {
    const directory = await temporaryDirectory();
    const fixtures = [
      ["image.jpg", "image/jpeg", jpegFixture()],
      ["image.gif", "image/gif", gifFixture(1)],
      ["image.webp", "image/webp", webpFixture()],
      [
        "image-lossy.webp",
        "image/webp",
        webpContainer([webpChunk("VP8 ", webpLossyPayload())]),
      ],
    ] as const;
    await Promise.all(fixtures.map(([name, , bytes]) =>
      writeFile(join(directory, name), bytes)));
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };
    for (const [name, mimeType, bytes] of fixtures) {
      const response = await resolveWorkspaceImagePreviewResponse(
        resolver,
        request(name),
      );
      expect(response.headers.get("Content-Type")).toBe(mimeType);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
  });

  it("rejects oversized decoded dimensions and animation frame counts", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "wide.png"), pngFixture({ width: 20_000 }));
    await writeFile(join(directory, "dense.png"), pngFixture({
      width: 3_000,
      height: 3_000,
    }));
    await writeFile(join(directory, "wide.jpg"), jpegFixture(20_000));
    await writeFile(join(directory, "many.png"), apngFixture(257));
    await writeFile(join(directory, "many.gif"), gifFixture(257));
    await writeFile(join(directory, "many.webp"), animatedWebpFixture(257));
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };
    await expect(resolveWorkspaceImagePreviewResponse(
      resolver,
      request("wide.png"),
    )).rejects.toThrow("unsafe decoded dimensions or frames");
    for (const name of [
      "dense.png",
      "wide.jpg",
      "many.png",
      "many.gif",
      "many.webp",
    ]) {
      await expect(resolveWorkspaceImagePreviewResponse(
        resolver,
        request(name),
      )).rejects.toThrow("unsafe decoded dimensions or frames");
    }
  });

  it("bounds GIF container records independently from payload sub-blocks", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "nested.gif");
    await writeFile(path, adversarialGifExtensions(4_200));
    await expect(resolveWorkspaceImagePreviewResponse(
      { resolveProjectPath: async () => path },
      request("nested.gif"),
    )).rejects.toThrow("structural inspection budget");
  });

  it("accepts near-limit GIF payload blocks without weakening termination bounds", async () => {
    const directory = await temporaryDirectory();
    const nearLimit = gifDataSubBlocks({
      payloadBytes: MAX_WORKSPACE_IMAGE_PREVIEW_BYTES - 50_000,
    });
    expect(nearLimit.length).toBeGreaterThan(9 * 1024 * 1024);
    expect(nearLimit.length).toBeLessThan(MAX_WORKSPACE_IMAGE_PREVIEW_BYTES);
    const validPath = join(directory, "near-limit.gif");
    await writeFile(validPath, nearLimit);
    const response = await resolveWorkspaceImagePreviewResponse(
      { resolveProjectPath: async () => validPath },
      request("near-limit.gif"),
    );
    await response.body!.cancel();

    const excessivePath = join(directory, "excessive-blocks.gif");
    await writeFile(excessivePath, gifDataSubBlocks({ blocks: 50_000 }));
    await expect(resolveWorkspaceImagePreviewResponse(
      { resolveProjectPath: async () => excessivePath },
      request("excessive-blocks.gif"),
    )).rejects.toThrow("data sub-block budget");

    const truncatedPath = join(directory, "truncated.gif");
    await writeFile(truncatedPath, gifDataSubBlocks({
      payloadBytes: 128,
      terminate: false,
    }));
    await expect(resolveWorkspaceImagePreviewResponse(
      { resolveProjectPath: async () => truncatedPath },
      request("truncated.gif"),
    )).rejects.toThrow("truncated");
  });

  it("rejects long JPEG marker fill runs before scanning attacker-sized data", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "fill.jpg");
    await writeFile(path, Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(34, 0xff),
      jpegFixture().subarray(4),
    ]));
    await expect(resolveWorkspaceImagePreviewResponse(
      { resolveProjectPath: async () => path },
      request("fill.jpg"),
    )).rejects.toThrow("marker fill is too long");
  });

  it("requires exact APNG controls, bounded rectangles, and valid data ordering", async () => {
    const directory = await temporaryDirectory();
    const valid = apngFixture(2);
    await writeFile(join(directory, "valid.png"), valid);
    const mismatchedCount = apngFixture(1, 2);
    await writeFile(join(directory, "count.png"), mismatchedCount);
    const badRectangle = Buffer.from(apngFixture(1));
    const frameControl = badRectangle.indexOf("fcTL", 0, "ascii");
    badRectangle.writeUInt32BE(2, frameControl + 8);
    await writeFile(join(directory, "rectangle.png"), badRectangle);
    const misplacedData = Buffer.from(apngFixture(1));
    const firstControl = misplacedData.indexOf("fcTL", 0, "ascii");
    misplacedData.write("fdAT", firstControl, "ascii");
    await writeFile(join(directory, "ordering.png"), misplacedData);
    const duplicateHeader = Buffer.from(apngFixture(1));
    const animationHeaderType = duplicateHeader.indexOf("acTL", 0, "ascii");
    const animationHeaderStart = animationHeaderType - 4;
    const animationHeader = duplicateHeader.subarray(
      animationHeaderStart,
      animationHeaderStart + 20,
    );
    const duplicateControl = duplicateHeader.indexOf("fcTL", 0, "ascii") - 4;
    const duplicatedHeader = Buffer.concat([
      duplicateHeader.subarray(0, duplicateControl),
      animationHeader,
      duplicateHeader.subarray(duplicateControl),
    ]);
    const lateHeaderBase = pngFixture();
    const imageEnd = lateHeaderBase.indexOf("IEND", 0, "ascii") - 4;
    const lateHeader = Buffer.concat([
      lateHeaderBase.subarray(0, imageEnd),
      animationHeader,
      lateHeaderBase.subarray(imageEnd),
    ]);
    const repeatedControlBase = apngFixture(1);
    const repeatedControlStart = repeatedControlBase.indexOf("fcTL", 0, "ascii") - 4;
    const repeatedControl = repeatedControlBase.subarray(
      repeatedControlStart,
      repeatedControlStart + 38,
    );
    const repeatedControls = Buffer.concat([
      repeatedControlBase.subarray(0, repeatedControlStart + 38),
      repeatedControl,
      repeatedControlBase.subarray(repeatedControlStart + 38),
    ]);
    const dataWithoutControlBase = apngFixture(1);
    const dataWithoutControlEnd = dataWithoutControlBase.indexOf(
      "IEND",
      0,
      "ascii",
    ) - 4;
    const unownedFrameData = Buffer.alloc(5);
    unownedFrameData.writeUInt32BE(1, 0);
    const dataWithoutControl = Buffer.concat([
      dataWithoutControlBase.subarray(0, dataWithoutControlEnd),
      pngChunk("fdAT", unownedFrameData),
      dataWithoutControlBase.subarray(dataWithoutControlEnd),
    ]);
    await writeFile(join(directory, "duplicate.png"), duplicatedHeader);
    await writeFile(join(directory, "late.png"), lateHeader);
    await writeFile(join(directory, "controls.png"), repeatedControls);
    await writeFile(join(directory, "unowned-data.png"), dataWithoutControl);
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };

    const response = await resolveWorkspaceImagePreviewResponse(
      resolver,
      request("valid.png"),
    );
    await response.body!.cancel();
    for (const name of [
      "count.png",
      "rectangle.png",
      "ordering.png",
      "duplicate.png",
      "late.png",
      "controls.png",
      "unowned-data.png",
    ]) {
      await expect(resolveWorkspaceImagePreviewResponse(
        resolver,
        request(name),
      )).rejects.toThrow(/PNG/u);
    }
  });

  it("validates WebP canvas, nested frame bitstreams, and chunk state", async () => {
    const directory = await temporaryDirectory();
    const mismatchedCanvas = webpContainer([
      webpChunk("VP8X", webpExtendedHeader(2, 1, false)),
      webpChunk("VP8L", webpLosslessPayload(1, 1)),
    ]);
    const mismatchedFrame = webpContainer([
      webpChunk("VP8X", webpExtendedHeader(2, 1, true)),
      webpChunk("ANIM", Buffer.alloc(6)),
      webpChunk("ANMF", webpAnimationFrame(2, 1, 1, 1)),
    ]);
    const duplicateImage = webpContainer([
      webpChunk("VP8L", webpLosslessPayload()),
      webpChunk("VP8L", webpLosslessPayload()),
    ]);
    const misplacedHeader = webpContainer([
      webpChunk("VP8L", webpLosslessPayload()),
      webpChunk("VP8X", webpExtendedHeader(1, 1, false)),
    ]);
    const missingAnimationHeader = webpContainer([
      webpChunk("VP8X", webpExtendedHeader(1, 1, true)),
      webpChunk("ANMF", webpAnimationFrame(1, 1)),
    ]);
    const animationInStatic = webpContainer([
      webpChunk("VP8X", webpExtendedHeader(1, 1, false)),
      webpChunk("ANIM", Buffer.alloc(6)),
    ]);
    const topLevelImageInAnimation = webpContainer([
      webpChunk("VP8X", webpExtendedHeader(1, 1, true)),
      webpChunk("ANIM", Buffer.alloc(6)),
      webpChunk("VP8L", webpLosslessPayload()),
    ]);
    const fixtures = {
      "canvas.webp": mismatchedCanvas,
      "frame.webp": mismatchedFrame,
      "duplicate.webp": duplicateImage,
      "misplaced.webp": misplacedHeader,
      "missing-anim.webp": missingAnimationHeader,
      "static-anim.webp": animationInStatic,
      "animated-static-image.webp": topLevelImageInAnimation,
    };
    await Promise.all(Object.entries(fixtures).map(([name, bytes]) =>
      writeFile(join(directory, name), bytes)));
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };
    for (const name of Object.keys(fixtures)) {
      await expect(resolveWorkspaceImagePreviewResponse(
        resolver,
        request(name),
      )).rejects.toThrow(/WebP/u);
    }
  });

  it("holds weighted bytes until cancellation and restores the cap", async () => {
    const directory = await temporaryDirectory();
    const large = pngFixture({ totalBytes: 8 * 1024 * 1024 });
    await Promise.all(["one.png", "two.png", "three.png"].map((name) =>
      writeFile(join(directory, name), large)));
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };
    const first = await resolveWorkspaceImagePreviewResponse(resolver, request("one.png"));
    const second = await resolveWorkspaceImagePreviewResponse(resolver, request("two.png"));
    let thirdSettled = false;
    const thirdPending = resolveWorkspaceImagePreviewResponse(
      resolver,
      request("three.png"),
    ).then((response) => {
      thirdSettled = true;
      return response;
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    expect(thirdSettled).toBe(false);

    await first.body!.cancel();
    await waitFor(() => thirdSettled);
    const third = await thirdPending;
    await Promise.all([second.body!.cancel(), third.body!.cancel()]);

    const afterCancellation = await resolveWorkspaceImagePreviewResponse(
      resolver,
      request("one.png"),
    );
    await afterCancellation.body!.cancel();
  });

  it("removes an aborted queued request and closes its waiting file", async () => {
    const directory = await temporaryDirectory();
    const large = pngFixture({ totalBytes: 8 * 1024 * 1024 });
    const paths = ["held-one.png", "held-two.png", "aborted.png"];
    await Promise.all(paths.map((name) => writeFile(join(directory, name), large)));
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };
    const first = await resolveWorkspaceImagePreviewResponse(
      resolver,
      request(paths[0]!),
    );
    const second = await resolveWorkspaceImagePreviewResponse(
      resolver,
      request(paths[1]!),
    );
    const controller = new AbortController();
    let abortedSettled = false;
    const aborted = resolveWorkspaceImagePreviewResponse(
      resolver,
      request(paths[2]!),
      controller.signal,
    ).finally(() => {
      abortedSettled = true;
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    expect(abortedSettled).toBe(false);
    controller.abort();
    await expect(aborted).rejects.toThrow("request was cancelled");
    await rm(join(directory, paths[2]!));

    let replacementSettled = false;
    const replacementPending = resolveWorkspaceImagePreviewResponse(
      resolver,
      request(paths[0]!),
    ).then((response) => {
      replacementSettled = true;
      return response;
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    expect(replacementSettled).toBe(false);
    await first.body!.cancel();
    await waitFor(() => replacementSettled);
    const replacement = await replacementPending;
    await Promise.all([second.body!.cancel(), replacement.body!.cancel()]);
  });

  it("disposes an active stream and releases its byte lease on abort", async () => {
    const directory = await temporaryDirectory();
    const large = pngFixture({ totalBytes: 8 * 1024 * 1024 });
    const paths = ["active.png", "held.png", "next.png"];
    await Promise.all(paths.map((name) => writeFile(join(directory, name), large)));
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };
    const controller = new AbortController();
    const active = await resolveWorkspaceImagePreviewResponse(
      resolver,
      request(paths[0]!),
      controller.signal,
    );
    const held = await resolveWorkspaceImagePreviewResponse(
      resolver,
      request(paths[1]!),
    );
    let nextSettled = false;
    const nextPending = resolveWorkspaceImagePreviewResponse(
      resolver,
      request(paths[2]!),
    ).then((response) => {
      nextSettled = true;
      return response;
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    expect(nextSettled).toBe(false);

    controller.abort();
    await expect(active.arrayBuffer()).rejects.toThrow("request was cancelled");
    await waitFor(() => nextSettled);
    await rm(join(directory, paths[0]!));
    const next = await nextPending;
    await Promise.all([held.body!.cancel(), next.body!.cancel()]);
  });

  it("releases weighted bytes after stream completion without full-size chunks", async () => {
    const directory = await temporaryDirectory();
    const bytes = pngFixture({ totalBytes: 8 * 1024 * 1024 });
    const imagePath = join(directory, "stream.png");
    await writeFile(imagePath, bytes);
    const allocations: number[] = [];
    const originalAllocUnsafe = Buffer.allocUnsafe;
    const allocationSpy = vi.spyOn(Buffer, "allocUnsafe").mockImplementation((size) => {
      allocations.push(size);
      return originalAllocUnsafe(size);
    });
    try {
      const resolver = { resolveProjectPath: async () => imagePath };
      const response = await resolveWorkspaceImagePreviewResponse(
        resolver,
        request("stream.png"),
      );
      const held = await resolveWorkspaceImagePreviewResponse(
        resolver,
        request("stream.png"),
      );
      let queuedSettled = false;
      const queued = resolveWorkspaceImagePreviewResponse(
        resolver,
        request("stream.png"),
      ).then((next) => {
        queuedSettled = true;
        return next;
      });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
      expect(queuedSettled).toBe(false);
      const reader = response.body!.getReader();
      let streamedBytes = 0;
      let maximumChunk = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        streamedBytes += result.value.byteLength;
        maximumChunk = Math.max(maximumChunk, result.value.byteLength);
      }
      expect(streamedBytes).toBe(bytes.length);
      expect(maximumChunk).toBeLessThanOrEqual(64 * 1024);
      expect(Math.max(...allocations)).toBeLessThanOrEqual(64 * 1024);
      await waitFor(() => queuedSettled);
      const next = await queued;
      await Promise.all([held.body!.cancel(), next.body!.cancel()]);
    } finally {
      allocationSpy.mockRestore();
    }
  });
});
