import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
}));

import { createAppProtocolRegistrar } from "../../src/main/app-protocol";
import type { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { resolveWorkspaceImagePreviewResponse } from "../../src/main/workspace-image-preview";
import { resolveWorkspaceMediaPreviewResponse } from "../../src/main/workspace-media-preview";
import { resolveWorkspacePathForOpen } from "../../src/server/workspace";
import {
  classifyWorkspaceMediaPath,
  MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES,
  parseWorkspaceMediaPreviewUrl,
  workspaceMediaFileName,
  workspaceMediaPreviewUrl,
} from "../../src/shared/workspace-media-preview";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "inertia-workspace-media-")),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function mediaRequest(relativePath: string, conversationId: string | undefined = CONVERSATION_ID) {
  return {
    projectId: PROJECT_ID,
    ...(conversationId ? { conversationId } : {}),
    relativePath,
    action: "open-externally" as const,
  };
}

function webRequest(
  relativePath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    conversationId?: string;
  } = {},
): Request {
  const url = workspaceMediaPreviewUrl({
    projectId: PROJECT_ID,
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    relativePath,
  });
  return new Request(url, {
    method: options.method ?? "GET",
    headers: options.headers,
    signal: options.signal,
  });
}

function pngChunk(kind: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(kind, "ascii"), data, Buffer.alloc(4)]);
}

function pngFixture(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([0])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function bmpFixture(width: number, height: number, options: { topDown?: boolean } = {}): Buffer {
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(58, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(options.topDown ? -height : height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  return Buffer.concat([header, Buffer.alloc(4)]);
}

function dibHeaderFixture(width: number, height: number): Buffer {
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(width, 4);
  dib.writeInt32LE(height * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  return dib;
}

function icoFixture(width: number, height: number, embeddedPayload?: Buffer): Buffer {
  const payload = embeddedPayload ?? dibHeaderFixture(width, height);
  const entry = Buffer.alloc(16);
  entry[0] = width === 256 ? 0 : width;
  entry[1] = height === 256 ? 0 : height;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(payload.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([
    Buffer.from([0, 0, 1, 0, 1, 0]),
    entry,
    payload,
  ]);
}

function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
}

function avifFixture(width: number, height: number, brand = "avif"): Buffer {
  const ftypPayload = Buffer.concat([
    Buffer.from(brand, "ascii"),
    Buffer.alloc(4),
    Buffer.from("mif1", "ascii"),
    Buffer.from(brand, "ascii"),
  ]);
  const ispePayload = Buffer.alloc(12);
  ispePayload.writeUInt32BE(width, 4);
  ispePayload.writeUInt32BE(height, 8);
  const ipco = isoBox("ipco", isoBox("ispe", ispePayload));
  const iprp = isoBox("iprp", ipco);
  const meta = isoBox("meta", Buffer.concat([Buffer.alloc(4), iprp]));
  return Buffer.concat([isoBox("ftyp", ftypPayload), meta]);
}

function mp4Fixture(payloadBytes = 256): Buffer {
  const ftyp = isoBox("ftyp", Buffer.from("isom\0\0\x02\0isomiso2mp41", "latin1"));
  const mdatPayload = Buffer.alloc(payloadBytes);
  for (let index = 0; index < payloadBytes; index += 1) {
    mdatPayload[index] = index & 0xff;
  }
  return Buffer.concat([ftyp, isoBox("mdat", mdatPayload)]);
}

function webmFixture(payloadBytes = 128): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]),
    Buffer.alloc(payloadBytes, 0x5a),
  ]);
}

function wavFixture(payloadBytes = 128): Buffer {
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + payloadBytes, 4);
  header.write("WAVE", 8, "ascii");
  return Buffer.concat([header, Buffer.alloc(payloadBytes, 0x11)]);
}

function mp3Id3Fixture(payloadBytes = 128): Buffer {
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    Buffer.alloc(payloadBytes, 0xaa),
  ]);
}

function mp3FrameSyncFixture(payloadBytes = 64): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    Buffer.alloc(payloadBytes, 0x22),
  ]);
}

interface ZipEntryInput {
  readonly name: string;
  readonly data: Buffer;
  readonly compress?: boolean;
  readonly overrideUncompressedSize?: number;
}

function createZipArchive(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const method = entry.compress ? 8 : 0;
    const compressed = entry.compress ? deflateRawSync(entry.data) : entry.data;
    const checksum = crc32(entry.data) >>> 0;
    const uncompressedSize = entry.overrideUncompressedSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

describe("workspace media preview protocol handler", () => {
  it("ignores Object.prototype property names and classifies literal # and ? paths accurately", () => {
    expect(classifyWorkspaceMediaPath("foo.constructor")).toBeNull();
    expect(classifyWorkspaceMediaPath("foo.toString")).toBeNull();
    expect(classifyWorkspaceMediaPath("foo.__proto__")).toBeNull();
    expect(classifyWorkspaceMediaPath("docs/demo#final.pdf")?.kind).toBe("pdf");
    expect(classifyWorkspaceMediaPath("docs/demo?final.xlsx")?.kind).toBe("spreadsheet");
    expect(classifyWorkspaceMediaPath("docs/demo.pdf#draft.txt")).toBeNull();
    expect(workspaceMediaFileName("docs/demo#final.pdf")).toBe("demo#final.pdf");
  });

  it("accepts comment/DOCTYPE-prefixed SVGs, UTF-16 BOM spreadsheets, and 4K 32-bit BMPs on both image routes", async () => {
    const directory = await temporaryDirectory();
    const commentSvg = Buffer.from(
      '<!-- generated icon -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
      "utf8",
    );
    const doctypeSvg = Buffer.from(
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [<!-- [ -->]>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "utf8",
    );
    const htmlWithEmbeddedSvg = Buffer.from(
      "<!-- decoy -->\n<html><body><svg></svg></body></html>",
      "utf8",
    );
    const utf16LeCsv = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("Item,Price\nCafé,42\n", "utf16le"),
    ]);
    const utf16BeText = Buffer.from("Col1\tCol2\nA\tB\n", "utf16le");
    utf16BeText.swap16();
    const utf16BeTsv = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeText]);
    const utf16LeWithNul = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("A\0B\n", "utf16le"),
    ]);

    // Real 3840x2160 32-bit uncompressed BMP (~31.64 MiB payload)
    const pixelBytes = 3_840 * 2_160 * 4;
    const bmp4k = Buffer.alloc(54 + pixelBytes);
    bmp4k.write("BM", 0, "ascii");
    bmp4k.writeUInt32LE(bmp4k.length, 2);
    bmp4k.writeUInt32LE(54, 10);
    bmp4k.writeUInt32LE(40, 14);
    bmp4k.writeInt32LE(3_840, 18);
    bmp4k.writeInt32LE(2_160, 22);
    bmp4k.writeUInt16LE(1, 26);
    bmp4k.writeUInt16LE(32, 28);

    await Promise.all([
      writeFile(join(directory, "comment.svg"), commentSvg),
      writeFile(join(directory, "doctype.svg"), doctypeSvg),
      writeFile(join(directory, "html-decoy.svg"), htmlWithEmbeddedSvg),
      writeFile(join(directory, "utf16le.csv"), utf16LeCsv),
      writeFile(join(directory, "utf16be.tsv"), utf16BeTsv),
      writeFile(join(directory, "utf16-nul.csv"), utf16LeWithNul),
      writeFile(join(directory, "4k.bmp"), bmp4k),
      writeFile(join(directory, "extensionless-4k-bmp"), bmp4k),
      writeFile(join(directory, "oversized-png.bmp"), Buffer.concat([pngFixture(64, 64), Buffer.alloc(26 * 1024 * 1024)])),
    ]);

    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) => {
        if (relativePath === "linked-4k.bmp") return join(directory, "extensionless-4k-bmp");
        if (relativePath === "extensionless-bmp-link") return join(directory, "4k.bmp");
        return join(directory, relativePath);
      },
    };

    for (const file of ["comment.svg", "doctype.svg"]) {
      const mediaRes = await resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest(file),
        webRequest(file),
      );
      expect(mediaRes.status).toBe(200);
      expect(mediaRes.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      await mediaRes.body!.cancel();

      const imageRes = await resolveWorkspaceImagePreviewResponse(
        resolver,
        mediaRequest(file),
      );
      expect(imageRes.status).toBe(200);
      expect(imageRes.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      await imageRes.body!.cancel();
    }

    await expect(resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("html-decoy.svg"),
      webRequest("html-decoy.svg"),
    )).rejects.toThrow();
    await expect(resolveWorkspaceImagePreviewResponse(
      resolver,
      mediaRequest("html-decoy.svg"),
    )).rejects.toThrow();

    const leRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("utf16le.csv"),
      webRequest("utf16le.csv"),
    );
    expect(leRes.status).toBe(200);
    expect(await leRes.text()).toBe("Item,Price\nCafé,42\n");

    const beRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("utf16be.tsv"),
      webRequest("utf16be.tsv"),
    );
    expect(beRes.status).toBe(200);
    expect(await beRes.text()).toBe("Col1\tCol2\nA\tB\n");

    await expect(resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("utf16-nul.csv"),
      webRequest("utf16-nul.csv"),
    )).rejects.toThrow(/NUL/iu);

    for (const bmpName of ["4k.bmp", "linked-4k.bmp"]) {
      const bmpMediaRes = await resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest(bmpName),
        webRequest(bmpName),
      );
      expect(bmpMediaRes.status).toBe(200);
      expect(bmpMediaRes.headers.get("Content-Type")).toBe("image/bmp");
      expect(bmpMediaRes.headers.get("Content-Length")).toBe(String(bmp4k.length));
      await bmpMediaRes.body!.cancel();

      const bmpImageRes = await resolveWorkspaceImagePreviewResponse(
        resolver,
        mediaRequest(bmpName),
      );
      expect(bmpImageRes.status).toBe(200);
      expect(bmpImageRes.headers.get("Content-Type")).toBe("image/bmp");
      expect(bmpImageRes.headers.get("Content-Length")).toBe(String(bmp4k.length));
      await bmpImageRes.body!.cancel();
    }

    const extensionlessBmpImageRes = await resolveWorkspaceImagePreviewResponse(
      resolver,
      mediaRequest("extensionless-bmp-link"),
    );
    expect(extensionlessBmpImageRes.status).toBe(200);
    expect(extensionlessBmpImageRes.headers.get("Content-Type")).toBe("image/bmp");
    expect(extensionlessBmpImageRes.headers.get("Content-Length")).toBe(String(bmp4k.length));
    await extensionlessBmpImageRes.body!.cancel();

    await expect(resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("oversized-png.bmp"),
      webRequest("oversized-png.bmp"),
    )).rejects.toThrow(/size limit/iu);
    await expect(resolveWorkspaceImagePreviewResponse(
      resolver,
      mediaRequest("oversized-png.bmp"),
    )).rejects.toThrow(/size limit/iu);
  });

  it("closes queued range stream handles cleanly on abort without leaking slots", async () => {
    const directory = await temporaryDirectory();
    const mp4 = mp4Fixture(2048);
    await writeFile(join(directory, "clip.mp4"), mp4);
    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };

    const activeResponses: Response[] = [];
    try {
      for (let index = 0; index < 32; index += 1) {
        activeResponses.push(await resolveWorkspaceMediaPreviewResponse(
          resolver,
          mediaRequest("clip.mp4"),
          webRequest("clip.mp4", { headers: { Range: "bytes=0-127" } }),
        ));
      }

      const abortController = new AbortController();
      const queuedPromise = resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest("clip.mp4"),
        webRequest("clip.mp4", {
          headers: { Range: "bytes=0-127" },
          signal: abortController.signal,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      abortController.abort();
      await expect(queuedPromise).rejects.toThrow(/cancelled/iu);
    } finally {
      await Promise.all(activeResponses.map((res) => res.body?.cancel() ?? Promise.resolve()));
    }

    const afterDrain = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("clip.mp4"),
      webRequest("clip.mp4", { headers: { Range: "bytes=0-63" } }),
    );
    expect(afterDrain.status).toBe(206);
    await afterDrain.body!.cancel();
  });

  it("validates 4K PNG, BMP, ICO, AVIF, and sandboxed SVG images", async () => {
    const directory = await temporaryDirectory();
    const png4k = pngFixture(3_840, 2_160);
    const bmp = bmpFixture(640, 480, { topDown: true });
    const ico = icoFixture(256, 256);
    const avif = avifFixture(1_920, 1_080);
    const svgDirect = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', "utf8");
    const svgXml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");

    await Promise.all([
      writeFile(join(directory, "4k.png"), png4k),
      writeFile(join(directory, "photo.bmp"), bmp),
      writeFile(join(directory, "favicon.ico"), ico),
      writeFile(join(directory, "hero.avif"), avif),
      writeFile(join(directory, "icon.svg"), svgDirect),
      writeFile(join(directory, "xml-icon.svg"), svgXml),
      writeFile(join(directory, "huge.avif"), avifFixture(20_000, 1_000)),
      writeFile(join(directory, "fake.avif"), mp4Fixture(64)),
      writeFile(join(directory, "huge-png.ico"), icoFixture(32, 32, pngFixture(20_000, 1_000))),
      writeFile(join(directory, "bad.svg"), "not valid svg markup"),
      writeFile(join(directory, "nul.svg"), Buffer.from("<svg>\0</svg>", "utf8")),
    ]);

    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };

    const cases = [
      ["4k.png", "image/png", png4k],
      ["photo.bmp", "image/bmp", bmp],
      ["favicon.ico", "image/x-icon", ico],
      ["hero.avif", "image/avif", avif],
      ["icon.svg", "image/svg+xml", svgDirect],
      ["xml-icon.svg", "image/svg+xml", svgXml],
    ] as const;

    for (const [name, expectedMime, expectedBytes] of cases) {
      const response = await resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest(name),
        webRequest(name),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(expectedMime);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      if (expectedMime === "image/svg+xml") {
        expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
      }
      expect(Buffer.from(await response.arrayBuffer())).toEqual(expectedBytes);

      const headResponse = await resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest(name),
        webRequest(name, { method: "HEAD" }),
      );
      expect(headResponse.status).toBe(200);
      expect(headResponse.headers.get("Content-Length")).toBe(String(expectedBytes.length));
      expect(Buffer.from(await headResponse.arrayBuffer()).length).toBe(0);
    }

    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("huge.avif"), webRequest("huge.avif")),
    ).rejects.toThrow("unsafe decoded dimensions");
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("fake.avif"), webRequest("fake.avif")),
    ).rejects.toThrow("not a supported image");
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("huge-png.ico"), webRequest("huge-png.ico")),
    ).rejects.toThrow("unsafe decoded dimensions");
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("bad.svg"), webRequest("bad.svg")),
    ).rejects.toThrow("not a supported image");
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("nul.svg"), webRequest("nul.svg")),
    ).rejects.toThrow("NUL bytes");

    const hugeDibIco = icoFixture(16, 16, dibHeaderFixture(16_384, 16_384));
    const tkhdBox = (width: number, height: number): Buffer => {
      const payload = Buffer.alloc(84);
      payload.writeUInt32BE(width * 65_536, 76);
      payload.writeUInt32BE(height * 65_536, 80);
      return isoBox("tkhd", payload);
    };
    const stszBox = (sampleCount: number, sampleSize = 0): Buffer => {
      const payload = Buffer.alloc(12);
      payload.writeUInt32BE(sampleSize, 4);
      payload.writeUInt32BE(sampleCount, 8);
      return isoBox("stsz", payload);
    };
    const stscBox = (entries: readonly [number, number][]): Buffer => {
      const payload = Buffer.alloc(8 + entries.length * 12);
      payload.writeUInt32BE(entries.length, 4);
      entries.forEach(([firstChunk, samplesPerChunk], index) => {
        payload.writeUInt32BE(firstChunk, 8 + index * 12);
        payload.writeUInt32BE(samplesPerChunk, 12 + index * 12);
        payload.writeUInt32BE(1, 16 + index * 12);
      });
      return isoBox("stsc", payload);
    };
    const stcoBox = (chunkCount: number): Buffer => {
      const payload = Buffer.alloc(8 + chunkCount * 4);
      payload.writeUInt32BE(chunkCount, 4);
      return isoBox("stco", payload);
    };
    const co64Box = (chunkCount: number): Buffer => {
      const payload = Buffer.alloc(8 + chunkCount * 8);
      payload.writeUInt32BE(chunkCount, 4);
      return isoBox("co64", payload);
    };
    const sttsBox = (sampleCount: number): Buffer => {
      const payload = Buffer.alloc(16);
      payload.writeUInt32BE(1, 4);
      payload.writeUInt32BE(sampleCount, 8);
      payload.writeUInt32BE(1, 12);
      return isoBox("stts", payload);
    };
    const stsdAv01Box = (codedW: number, codedH: number): Buffer => {
      const entryPayload = Buffer.alloc(28);
      entryPayload.writeUInt16BE(codedW, 24);
      entryPayload.writeUInt16BE(codedH, 26);
      const header = Buffer.alloc(8);
      header.writeUInt32BE(1, 4);
      return isoBox("stsd", Buffer.concat([header, isoBox("av01", entryPayload)]));
    };
    const animatedAvif = (
      ispeW: number,
      ispeH: number,
      tkhdW: number,
      tkhdH: number,
      stscSamples: number,
      options: {
        stszCount?: number;
        stszSampleSize?: number;
        useCo64?: boolean;
        sttsCount?: number;
        codedW?: number;
        codedH?: number;
      } = {},
    ): Buffer => {
      const base = avifFixture(ispeW, ispeH, "avis");
      const stblChildren = [
        stscBox([[1, stscSamples]]),
        options.useCo64 ? co64Box(1) : stcoBox(1),
        stszBox(options.stszCount ?? stscSamples, options.stszSampleSize ?? 0),
        ...(options.sttsCount !== undefined ? [sttsBox(options.sttsCount)] : []),
        ...(options.codedW !== undefined && options.codedH !== undefined
          ? [stsdAv01Box(options.codedW, options.codedH)]
          : []),
      ];
      const moov = isoBox(
        "moov",
        isoBox(
          "trak",
          Buffer.concat([
            tkhdBox(tkhdW, tkhdH),
            isoBox("mdia", isoBox("minf", isoBox("stbl", Buffer.concat(stblChildren)))),
          ]),
        ),
      );
      return Buffer.concat([base, moov]);
    };
    const truncatedStsd = (() => {
      const base = avifFixture(64, 64, "avis");
      const entryPayload = Buffer.alloc(28);
      entryPayload.writeUInt16BE(64, 24);
      entryPayload.writeUInt16BE(64, 26);
      const header = Buffer.alloc(8);
      header.writeUInt32BE(2, 4); // declares 2 entries, only 1 present
      const badStsd = isoBox("stsd", Buffer.concat([header, isoBox("av01", entryPayload)]));
      const moov = isoBox(
        "moov",
        isoBox("trak", Buffer.concat([
          tkhdBox(64, 64),
          isoBox("mdia", isoBox("minf", isoBox("stbl", Buffer.concat([
            stscBox([[1, 2]]),
            stcoBox(1),
            stszBox(2),
            badStsd,
          ])))),
        ])),
      );
      return Buffer.concat([base, moov]);
    })();
    const duplicateStsz = (() => {
      const base = avifFixture(64, 64, "avis");
      const moov = isoBox(
        "moov",
        isoBox("trak", Buffer.concat([
          tkhdBox(64, 64),
          isoBox("mdia", isoBox("minf", isoBox("stbl", Buffer.concat([
            stscBox([[1, 2]]),
            stcoBox(1),
            stszBox(99),
            stszBox(2),
          ])))),
        ])),
      );
      return Buffer.concat([base, moov]);
    })();
    await Promise.all([
      writeFile(join(directory, "huge-dib.ico"), hugeDibIco),
      writeFile(join(directory, "valid-seq.avif"), animatedAvif(64, 64, 128, 128, 12, { useCo64: true, sttsCount: 12, codedW: 128, codedH: 128 })),
      writeFile(join(directory, "huge-tkhd.avif"), animatedAvif(16, 16, 20_000, 1_000, 4)),
      writeFile(join(directory, "many-frames.avif"), animatedAvif(64, 64, 64, 64, 300)),
      writeFile(join(directory, "fixed-stsz-bypass.avif"), animatedAvif(64, 64, 64, 64, 300, { stszCount: 1, stszSampleSize: 16 })),
      writeFile(join(directory, "fixed-stsz-zero.avif"), animatedAvif(64, 64, 64, 64, 12, { stszCount: 0, stszSampleSize: 16 })),
      writeFile(join(directory, "mismatched-stsz.avif"), animatedAvif(64, 64, 64, 64, 12, { stszCount: 4 })),
      writeFile(join(directory, "mismatched-stts.avif"), animatedAvif(64, 64, 64, 64, 12, { sttsCount: 8 })),
      writeFile(join(directory, "co64-many.avif"), animatedAvif(64, 64, 64, 64, 300, { useCo64: true })),
      writeFile(join(directory, "coded-pixel-bomb.avif"), animatedAvif(64, 64, 64, 64, 50, { codedW: 1_000, codedH: 1_000 })),
      writeFile(join(directory, "truncated-stsd.avif"), truncatedStsd),
      writeFile(join(directory, "duplicate-stsz.avif"), duplicateStsz),
    ]);

    const seqRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("valid-seq.avif"),
      webRequest("valid-seq.avif"),
    );
    expect(seqRes.status).toBe(200);
    await seqRes.body!.cancel();

    for (const malicious of [
      "huge-dib.ico",
      "huge-tkhd.avif",
      "many-frames.avif",
      "fixed-stsz-bypass.avif",
      "fixed-stsz-zero.avif",
      "mismatched-stsz.avif",
      "mismatched-stts.avif",
      "co64-many.avif",
      "coded-pixel-bomb.avif",
      "duplicate-stsz.avif",
    ]) {
      await expect(
        resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest(malicious), webRequest(malicious)),
      ).rejects.toThrow("unsafe decoded dimensions");
    }
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("truncated-stsd.avif"), webRequest("truncated-stsd.avif")),
    ).rejects.toThrow();

    if (process.platform !== "win32") {
      const fifoPath = join(directory, "trap.png");
      await promisify(execFile)("mkfifo", [fifoPath]);
      await expect(
        resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("trap.png"), webRequest("trap.png")),
      ).rejects.toThrow("bounded regular file");
    }
  });

  it("streams MP4, WebM, MP3, and WAV with full HTTP Range 206, 416, and HEAD support", async () => {
    const directory = await temporaryDirectory();
    const mp4 = mp4Fixture(300 * 1024);
    const webm = webmFixture(256);
    const mp3Id3 = mp3Id3Fixture(128);
    const mp3Sync = mp3FrameSyncFixture(128);
    const wav = wavFixture(128);

    await Promise.all([
      writeFile(join(directory, "clip.mp4"), mp4),
      writeFile(join(directory, "clip.webm"), webm),
      writeFile(join(directory, "song.mp3"), mp3Id3),
      writeFile(join(directory, "sync.mp3"), mp3Sync),
      writeFile(join(directory, "sound.wav"), wav),
      writeFile(join(directory, "fake.mp4"), "not a video"),
      writeFile(join(directory, "fake.webm"), "not a webm"),
      writeFile(join(directory, "fake.mp3"), "not an mp3"),
      writeFile(join(directory, "fake.wav"), "not a wav"),
    ]);

    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };

    // Full 200 GET and chunk size check (>128 KiB MP4)
    const fullResponse = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("clip.mp4"),
      webRequest("clip.mp4"),
    );
    expect(fullResponse.status).toBe(200);
    expect(fullResponse.headers.get("Content-Type")).toBe("video/mp4");
    expect(fullResponse.headers.get("Accept-Ranges")).toBe("bytes");
    expect(fullResponse.headers.get("Content-Length")).toBe(String(mp4.length));
    const reader = fullResponse.body!.getReader();
    const chunks: Uint8Array[] = [];
    let maxChunkSize = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      maxChunkSize = Math.max(maxChunkSize, next.value.byteLength);
    }
    expect(maxChunkSize).toBeLessThanOrEqual(128 * 1024);
    expect(Buffer.concat(chunks)).toEqual(mp4);

    // bytes=start-end -> 206
    const boundedRange = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("clip.mp4"),
      webRequest("clip.mp4", { headers: { Range: "bytes=10-109" } }),
    );
    expect(boundedRange.status).toBe(206);
    expect(boundedRange.headers.get("Accept-Ranges")).toBe("bytes");
    expect(boundedRange.headers.get("Content-Range")).toBe(`bytes 10-109/${mp4.length}`);
    expect(boundedRange.headers.get("Content-Length")).toBe("100");
    expect(Buffer.from(await boundedRange.arrayBuffer())).toEqual(mp4.subarray(10, 110));

    // bytes=start- -> 206 to EOF
    const openEndRange = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("clip.webm"),
      webRequest("clip.webm", { headers: { Range: `bytes=${webm.length - 20}-` } }),
    );
    expect(openEndRange.status).toBe(206);
    expect(openEndRange.headers.get("Content-Type")).toBe("video/webm");
    expect(openEndRange.headers.get("Content-Range")).toBe(
      `bytes ${webm.length - 20}-${webm.length - 1}/${webm.length}`,
    );
    expect(Buffer.from(await openEndRange.arrayBuffer())).toEqual(webm.subarray(webm.length - 20));

    // bytes=-suffix -> 206 last N bytes
    const suffixRange = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("song.mp3"),
      webRequest("song.mp3", { headers: { Range: "bytes=-32" } }),
    );
    expect(suffixRange.status).toBe(206);
    expect(suffixRange.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(suffixRange.headers.get("Content-Range")).toBe(
      `bytes ${mp3Id3.length - 32}-${mp3Id3.length - 1}/${mp3Id3.length}`,
    );
    expect(Buffer.from(await suffixRange.arrayBuffer())).toEqual(mp3Id3.subarray(mp3Id3.length - 32));

    // MPEG frame sync MP3 & WAV
    const syncResponse = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("sync.mp3"),
      webRequest("sync.mp3"),
    );
    expect(syncResponse.status).toBe(200);
    expect(Buffer.from(await syncResponse.arrayBuffer())).toEqual(mp3Sync);

    const wavResponse = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("sound.wav"),
      webRequest("sound.wav"),
    );
    expect(wavResponse.status).toBe(200);
    expect(wavResponse.headers.get("Content-Type")).toBe("audio/wav");
    expect(Buffer.from(await wavResponse.arrayBuffer())).toEqual(wav);

    // HEAD with and without Range
    const headFull = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("clip.mp4"),
      webRequest("clip.mp4", { method: "HEAD" }),
    );
    expect(headFull.status).toBe(200);
    expect(headFull.headers.get("Accept-Ranges")).toBe("bytes");
    expect(headFull.headers.get("Content-Length")).toBe(String(mp4.length));
    expect((await headFull.arrayBuffer()).byteLength).toBe(0);

    const headRange = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("clip.mp4"),
      webRequest("clip.mp4", { method: "HEAD", headers: { Range: "bytes=0-63" } }),
    );
    expect(headRange.status).toBe(206);
    expect(headRange.headers.get("Content-Range")).toBe(`bytes 0-63/${mp4.length}`);
    expect(headRange.headers.get("Content-Length")).toBe("64");
    expect((await headRange.arrayBuffer()).byteLength).toBe(0);

    // Invalid ranges -> 416 Range Not Satisfiable
    for (const invalidRange of [
      `bytes=${mp4.length}-`,
      "bytes=100-50",
      "bytes=-0",
      "bytes=0-1, 2-3",
      "items=0-10",
      "bytes=-",
    ]) {
      const response = await resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest("clip.mp4"),
        webRequest("clip.mp4", { headers: { Range: invalidRange } }),
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe(`bytes */${mp4.length}`);
    }

    const headInvalidRange = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("clip.mp4"),
      webRequest("clip.mp4", { method: "HEAD", headers: { Range: "bytes=100-50" } }),
    );
    expect(headInvalidRange.status).toBe(416);
    expect((await headInvalidRange.arrayBuffer()).byteLength).toBe(0);

    // .opus validated as OggS and served as audio/ogg for Chromium nosniff playback
    const opusBytes = Buffer.concat([Buffer.from("OggS", "ascii"), Buffer.alloc(60, 0x22)]);
    await writeFile(join(directory, "voice.opus"), opusBytes);
    const opusRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("voice.opus"),
      webRequest("voice.opus"),
    );
    expect(opusRes.status).toBe(200);
    expect(opusRes.headers.get("Content-Type")).toBe("audio/ogg");
    expect(opusRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await opusRes.arrayBuffer())).toEqual(opusBytes);

    // Invalid magic bytes rejected
    for (const bad of ["fake.mp4", "fake.webm", "fake.mp3", "fake.wav"]) {
      await expect(
        resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest(bad), webRequest(bad)),
      ).rejects.toThrow("does not match");
    }
  });

  it("validates PDF %PDF- header and supports GET, HEAD, and Range requests", async () => {
    const directory = await temporaryDirectory();
    const validPdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");
    const offsetPdf = Buffer.concat([Buffer.alloc(16, 0x20), validPdf]);
    const invalidPdf = Buffer.from("<html><body>not a pdf</body></html>", "utf8");
    const latePdf = Buffer.concat([Buffer.alloc(1_050, 0x20), validPdf]);

    await Promise.all([
      writeFile(join(directory, "report.pdf"), validPdf),
      writeFile(join(directory, "offset.pdf"), offsetPdf),
      writeFile(join(directory, "invalid.pdf"), invalidPdf),
      writeFile(join(directory, "late.pdf"), latePdf),
    ]);

    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };

    const getRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("report.pdf"),
      webRequest("report.pdf"),
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(getRes.headers.get("Accept-Ranges")).toBe("bytes");
    expect(Buffer.from(await getRes.arrayBuffer())).toEqual(validPdf);

    const rangeRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("offset.pdf"),
      webRequest("offset.pdf", { headers: { Range: "bytes=16-23" } }),
    );
    expect(rangeRes.status).toBe(206);
    expect(Buffer.from(await rangeRes.arrayBuffer()).toString("ascii")).toBe("%PDF-1.7");

    const headRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("report.pdf"),
      webRequest("report.pdf", { method: "HEAD" }),
    );
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("Content-Length")).toBe(String(validPdf.length));

    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("invalid.pdf"), webRequest("invalid.pdf")),
    ).rejects.toThrow("%PDF-");
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("late.pdf"), webRequest("late.pdf")),
    ).rejects.toThrow("%PDF-");
  });

  it("validates XLSX, XLSM, ODS, XLS spreadsheets and rejects ZIP bombs", async () => {
    const directory = await temporaryDirectory();
    const validXlsx = createZipArchive([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>", "utf8"), compress: true },
      { name: "xl/workbook.xml", data: Buffer.from("<workbook/>", "utf8"), compress: true },
    ]);
    const validOds = createZipArchive([
      { name: "mimetype", data: Buffer.from("application/vnd.oasis.opendocument.spreadsheet", "utf8") },
      { name: "content.xml", data: Buffer.from("<office:document-content/>", "utf8"), compress: true },
    ]);
    const validXls = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(64),
    ]);
    // ZIP bomb #1: huge highly-compressible XML entry exceeding ratio/expanded limits
    const xmlBomb = createZipArchive([
      { name: "xl/sheet1.xml", data: Buffer.alloc(1024 * 1024, 0x41), compress: true },
    ]);
    // ZIP bomb #2: huge declared uncompressed size on a binary entry in central directory
    const binaryDeclaredBomb = createZipArchive([
      {
        name: "xl/media/bomb.bin",
        data: Buffer.from("small", "utf8"),
        overrideUncompressedSize: 64 * 1024 * 1024,
      },
    ]);

    await Promise.all([
      writeFile(join(directory, "sheet.xlsx"), validXlsx),
      writeFile(join(directory, "macro.xlsm"), validXlsx),
      writeFile(join(directory, "calc.ods"), validOds),
      writeFile(join(directory, "legacy.xls"), validXls),
      writeFile(join(directory, "bomb.xlsx"), xmlBomb),
      writeFile(join(directory, "declared-bomb.xlsx"), binaryDeclaredBomb),
      writeFile(join(directory, "bad.xlsx"), "not a zip"),
      writeFile(join(directory, "bad.xls"), "not an ole2 file"),
    ]);

    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };

    const xlsxRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("sheet.xlsx"),
      webRequest("sheet.xlsx"),
    );
    expect(xlsxRes.status).toBe(200);
    expect(xlsxRes.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(Buffer.from(await xlsxRes.arrayBuffer())).toEqual(validXlsx);

    const xlsmRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("macro.xlsm"),
      webRequest("macro.xlsm"),
    );
    expect(xlsmRes.status).toBe(200);
    expect(xlsmRes.headers.get("Content-Type")).toBe("application/vnd.ms-excel.sheet.macroEnabled.12");

    const odsRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("calc.ods"),
      webRequest("calc.ods"),
    );
    expect(odsRes.status).toBe(200);
    expect(odsRes.headers.get("Content-Type")).toBe("application/vnd.oasis.opendocument.spreadsheet");

    const xlsRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("legacy.xls"),
      webRequest("legacy.xls"),
    );
    expect(xlsRes.status).toBe(200);
    expect(xlsRes.headers.get("Content-Type")).toBe("application/vnd.ms-excel");
    expect(Buffer.from(await xlsRes.arrayBuffer())).toEqual(validXls);

    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("bomb.xlsx"), webRequest("bomb.xlsx")),
    ).rejects.toThrow();
    await expect(
      resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest("declared-bomb.xlsx"),
        webRequest("declared-bomb.xlsx"),
      ),
    ).rejects.toThrow("expanded size limits");
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("bad.xlsx"), webRequest("bad.xlsx")),
    ).rejects.toThrow("ZIP signature");
    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("bad.xls"), webRequest("bad.xls")),
    ).rejects.toThrow("OLE2 header");
  });

  it("validates CSV/TSV UTF-8, handles 0-byte files, and safely truncates >10 MiB at UTF-8 boundaries", async () => {
    const directory = await temporaryDirectory();
    const validCsv = "name,value\nalpha,1\nbeta,2\n";
    const validTsv = "col1\tcol2\nfoo\tbar\n";
    // Build a >10 MiB CSV where a 4-byte emoji straddles the exact 10 MiB boundary
    const emoji = Buffer.from("🚀", "utf8"); // 4 bytes
    const prefixLength = MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES - 2;
    const hugeCsv = Buffer.concat([
      Buffer.alloc(prefixLength, 0x61), // 'a'
      emoji,
      Buffer.from("\nextra,row\n", "utf8"),
    ]);

    await Promise.all([
      writeFile(join(directory, "data.csv"), validCsv, "utf8"),
      writeFile(join(directory, "data.tsv"), validTsv, "utf8"),
      writeFile(join(directory, "empty.csv"), ""),
      writeFile(join(directory, "huge.csv"), hugeCsv),
      writeFile(join(directory, "nul.csv"), Buffer.from("a,b\n1,\0\n", "utf8")),
      writeFile(join(directory, "invalid-utf8.csv"), Buffer.from([0x61, 0x2c, 0xff, 0xfe])),
    ]);

    const resolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        join(directory, relativePath),
    };

    const csvRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("data.csv"),
      webRequest("data.csv"),
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(csvRes.headers.get("X-Workspace-Media-Truncated")).toBeNull();
    expect(await csvRes.text()).toBe(validCsv);

    const tsvRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("data.tsv"),
      webRequest("data.tsv"),
    );
    expect(tsvRes.status).toBe(200);
    expect(tsvRes.headers.get("Content-Type")).toBe("text/tab-separated-values; charset=utf-8");
    expect(await tsvRes.text()).toBe(validTsv);

    const emptyRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("empty.csv"),
      webRequest("empty.csv"),
    );
    expect(emptyRes.status).toBe(200);
    expect(emptyRes.headers.get("Content-Length")).toBe("0");
    expect(await emptyRes.text()).toBe("");

    const hugeRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("huge.csv"),
      webRequest("huge.csv"),
    );
    expect(hugeRes.status).toBe(200);
    expect(hugeRes.headers.get("X-Workspace-Media-Truncated")).toBe("true");
    const hugeBody = Buffer.from(await hugeRes.arrayBuffer());
    expect(hugeBody.byteLength).toBe(prefixLength);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(hugeBody)).not.toThrow();

    // UTF-16LE CJK CSV (<10 MiB raw, >10 MiB UTF-8) is clamped to <=10 MiB with truncation header
    const cjkChars = Math.ceil((MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES + 120) / 3);
    const utf16Cjk = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("漢".repeat(cjkChars), "utf16le"),
    ]);
    expect(utf16Cjk.byteLength).toBeLessThan(MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES);
    await writeFile(join(directory, "cjk-utf16.csv"), utf16Cjk);
    const utf16CjkRes = await resolveWorkspaceMediaPreviewResponse(
      resolver,
      mediaRequest("cjk-utf16.csv"),
      webRequest("cjk-utf16.csv"),
    );
    expect(utf16CjkRes.status).toBe(200);
    expect(utf16CjkRes.headers.get("X-Workspace-Media-Truncated")).toBe("true");
    const utf16CjkBody = Buffer.from(await utf16CjkRes.arrayBuffer());
    expect(utf16CjkBody.byteLength).toBeLessThanOrEqual(MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(utf16CjkBody)).not.toThrow();

    await expect(
      resolveWorkspaceMediaPreviewResponse(resolver, mediaRequest("nul.csv"), webRequest("nul.csv")),
    ).rejects.toThrow("NUL bytes");
    await expect(
      resolveWorkspaceMediaPreviewResponse(
        resolver,
        mediaRequest("invalid-utf8.csv"),
        webRequest("invalid-utf8.csv"),
      ),
    ).rejects.toThrow("valid UTF-8");
  });

  it("enforces symlink containment, URL traversal guards, unknown extension 404, and dev-only loopback CORS", async () => {
    const directory = await temporaryDirectory();
    const root = join(directory, "project");
    const outside = join(directory, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    await writeFile(join(outside, "secret.pdf"), "%PDF-1.7\n%%EOF\n");
    await writeFile(join(root, "ok.pdf"), "%PDF-1.7\n%%EOF\n");
    await symlink(
      outside,
      join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const containedResolver = {
      resolveProjectPath: async ({ relativePath }: { relativePath: string }) =>
        (await resolveWorkspacePathForOpen(root, relativePath)).absolute,
    };

    // Unknown extension fails closed with 404 without invoking resolver
    const spyResolver = { resolveProjectPath: vi.fn() };
    const unknownRes = await resolveWorkspaceMediaPreviewResponse(
      spyResolver,
      mediaRequest("payload.exe"),
      webRequest("payload.exe"),
    );
    expect(unknownRes.status).toBe(404);
    expect(spyResolver.resolveProjectPath).not.toHaveBeenCalled();

    // Symlink escape rejected
    await expect(
      resolveWorkspaceMediaPreviewResponse(
        containedResolver,
        mediaRequest("escape/secret.pdf"),
        webRequest("escape/secret.pdf"),
      ),
    ).rejects.toMatchObject({ code: "outside-workspace" });

    // Path traversal rejected by URL parser
    for (const badPath of [
      "..%2Fsecret.pdf",
      "%2Fetc%2Fpasswd.pdf",
      "C%3A%5Csecret.pdf",
      "bad%00.pdf",
    ]) {
      expect(parseWorkspaceMediaPreviewUrl(
        new URL(`inertia://bundle/workspace-media/${PROJECT_ID}/project/${badPath}`),
      )).toBeNull();
    }

    // Dev-only loopback CORS vs packaged & non-loopback
    const devLocalhost = await resolveWorkspaceMediaPreviewResponse(
      containedResolver,
      mediaRequest("ok.pdf"),
      webRequest("ok.pdf", { headers: { Origin: "http://localhost:5173" } }),
      { allowDevLoopbackCors: true },
    );
    expect(devLocalhost.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(devLocalhost.headers.get("Vary")).toBe("Origin");
    expect(devLocalhost.headers.get("Access-Control-Expose-Headers")).toBe(
      "Content-Length, Content-Range, Accept-Ranges, X-Workspace-Media-Truncated",
    );
    await devLocalhost.body!.cancel();

    const devIp = await resolveWorkspaceMediaPreviewResponse(
      containedResolver,
      mediaRequest("ok.pdf"),
      webRequest("ok.pdf", { headers: { Origin: "http://127.0.0.1:4173" } }),
      { allowDevLoopbackCors: true },
    );
    expect(devIp.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:4173");
    await devIp.body!.cancel();

    const devEvilOrigin = await resolveWorkspaceMediaPreviewResponse(
      containedResolver,
      mediaRequest("ok.pdf"),
      webRequest("ok.pdf", { headers: { Origin: "https://evil.example" } }),
      { allowDevLoopbackCors: true },
    );
    expect(devEvilOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
    await devEvilOrigin.body!.cancel();

    const packagedLocalhost = await resolveWorkspaceMediaPreviewResponse(
      containedResolver,
      mediaRequest("ok.pdf"),
      webRequest("ok.pdf", { headers: { Origin: "http://localhost:5173" } }),
      { allowDevLoopbackCors: false },
    );
    expect(packagedLocalhost.headers.get("Access-Control-Allow-Origin")).toBeNull();
    await packagedLocalhost.body!.cancel();

    // Detached conversationScope isolation through app-protocol registrar
    const handle = vi.fn();
    let handled = false;
    handle.mockImplementation(() => { handled = true; });
    const register = createAppProtocolRegistrar({
      scheme: "inertia",
      attachmentRegistry: () => null,
      conversationAttachments: () => null,
      runtimeSupervisor: () => ({
        resolveProjectPath: containedResolver.resolveProjectPath,
      }) as unknown as RuntimeSupervisor,
      allowDevLoopbackCors: false,
    });
    register(
      { handle, isProtocolHandled: () => handled } as never,
      CONVERSATION_ID,
    );
    const serve = handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;

    const ownConvRes = await serve(webRequest("ok.pdf", { conversationId: CONVERSATION_ID }));
    expect(ownConvRes.status).toBe(200);
    await ownConvRes.body!.cancel();

    const otherConvRes = await serve(webRequest("ok.pdf", { conversationId: OTHER_CONVERSATION_ID }));
    expect(otherConvRes.status).toBe(404);

    const projectScopedRes = await serve(webRequest("ok.pdf"));
    expect(projectScopedRes.status).toBe(404);
  });
});
