import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, vi } from "vitest";

const moduleUrl = pathToFileURL(join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "ci",
  "download-windows-n-minus-one.mjs",
)).href;

async function releaseModule() {
  return await import(moduleUrl) as {
    compareReleaseVersions: (left: string, right: string) => number;
    downloadBoundedFile: (
      url: string,
      destination: string,
      expectedBytes: number,
      token: string,
      timeouts: { bodyTimeoutMs: number; connectTimeoutMs: number },
    ) => Promise<void>;
    fetchBoundedText: (
      url: string,
      maximumBytes: number,
      token: string,
      accept: string,
      timeouts: { bodyTimeoutMs: number; connectTimeoutMs: number },
    ) => Promise<string>;
    main: (arguments_: string[]) => Promise<string>;
    releaseAssetChecksum: (contents: string, assetName: string) => string;
    selectWindowsNMinusOneRelease: (
      releases: unknown[],
      currentVersion: string,
      channel: "canary" | "stable",
      architecture: "arm64" | "x64",
    ) => {
      tag: string;
      version: string;
      assetName: string;
      assetSize: number;
      installerUrl: string;
      checksumsUrl: string;
    };
    windowsReleaseAssetName: (
      version: string,
      channel: "canary" | "stable",
      architecture: "arm64" | "x64",
    ) => string;
  };
}

function release(
  version: string,
  options: {
    readonly channel?: "canary" | "stable";
    readonly draft?: boolean;
    readonly prerelease?: boolean;
    readonly complete?: boolean;
  } = {},
) {
  const channel = options.channel ?? "stable";
  const asset = channel === "canary"
    ? `Inertia.Canary.Setup.${version}.exe`
    : `Inertia.Setup.${version}.exe`;
  return {
    tag_name: `${channel === "canary" ? "canary-v" : "v"}${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? channel === "canary",
    assets: [
      ...(options.complete === false
        ? []
        : [{
            name: asset,
            size: 240_000_000,
            browser_download_url: `https://github.com/eduardtomas1/inertia/releases/download/${channel === "canary" ? "canary-v" : "v"}${version}/${asset}`,
          }]),
      {
        name: "SHA256SUMS.txt",
        size: 1_024,
        browser_download_url: `https://github.com/eduardtomas1/inertia/releases/download/${channel === "canary" ? "canary-v" : "v"}${version}/SHA256SUMS.txt`,
      },
    ],
  };
}

test("selects the greatest complete release below the exact candidate", async () => {
  const {
    compareReleaseVersions,
    selectWindowsNMinusOneRelease,
    windowsReleaseAssetName,
  } = await releaseModule();

  expect(compareReleaseVersions("0.0.47", "0.0.48")).toBe(-1);
  expect(compareReleaseVersions("0.1.0", "0.0.99")).toBe(1);
  expect(compareReleaseVersions("1.2.3", "1.2.3")).toBe(0);
  expect(windowsReleaseAssetName("1.2.3", "stable", "x64"))
    .toBe("Inertia.Setup.1.2.3.exe");
  expect(windowsReleaseAssetName("1.2.3", "canary", "arm64"))
    .toBe("Inertia.Canary.Setup.1.2.3.arm64.exe");

  const selected = selectWindowsNMinusOneRelease([
    release("0.0.46"),
    release("0.0.49"),
    release("0.0.48", { complete: false }),
    release("0.0.47"),
    release("0.0.48", { draft: true }),
    release("0.0.48", { prerelease: true }),
    release("0.0.48", { channel: "canary" }),
  ], "0.0.49", "stable", "x64");

  expect(selected).toMatchObject({
    tag: "v0.0.47",
    version: "0.0.47",
    assetName: "Inertia.Setup.0.0.47.exe",
    assetSize: 240_000_000,
  });
});

test("fails closed without a prior complete architecture-specific release", async () => {
  const { selectWindowsNMinusOneRelease } = await releaseModule();

  expect(() => selectWindowsNMinusOneRelease(
    [release("0.0.48", { complete: false })],
    "0.0.49",
    "stable",
    "x64",
  )).toThrow("No complete packaged Windows N-1 release");
  expect(() => selectWindowsNMinusOneRelease(
    Array.from({ length: 101 }, () => release("0.0.48")),
    "0.0.49",
    "stable",
    "x64",
  )).toThrow("invalid or unbounded");
  const unsafe = release("0.0.48");
  unsafe.assets[0].browser_download_url = "https://example.invalid/installer.exe";
  expect(() => selectWindowsNMinusOneRelease(
    [unsafe],
    "0.0.49",
    "stable",
    "x64",
  )).toThrow("No complete packaged Windows N-1 release");
});

test("requires one exact checksum entry for the selected asset", async () => {
  const { releaseAssetChecksum } = await releaseModule();
  const digest = "a".repeat(64);
  const asset = "Inertia.Setup.0.0.47.exe";

  expect(releaseAssetChecksum(
    `${"b".repeat(64)}  unrelated.exe\n${digest}  ${asset}\n`,
    asset,
  )).toBe(digest);
  expect(() => releaseAssetChecksum(
    `${digest}  ${asset}\n${digest}  ${asset}\n`,
    asset,
  )).toThrow("no unique release checksum");
  expect(() => releaseAssetChecksum(`${digest} *${asset}\n`, asset))
    .toThrow("no unique release checksum");
});

test("requests release JSON separately from checksummed binary assets", async () => {
  const { main } = await releaseModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-n-minus-one-download-"));
  const installer = Buffer.from("packaged Windows N-1 fixture", "utf8");
  const digest = createHash("sha256").update(installer).digest("hex");
  const installerUrl = "https://github.com/eduardtomas1/inertia/releases/download/v0.0.47/Inertia.Setup.0.0.47.exe";
  const checksumsUrl = "https://github.com/eduardtomas1/inertia/releases/download/v0.0.47/SHA256SUMS.txt";
  const requests: Array<{ accept: string | null; authorization: string | null; url: string }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      accept: headers.get("accept"),
      authorization: headers.get("authorization"),
      url,
    });
    if (url.startsWith("https://api.github.com/")) {
      const body = JSON.stringify([{
        tag_name: "v0.0.47",
        draft: false,
        prerelease: false,
        assets: [
          {
            name: "Inertia.Setup.0.0.47.exe",
            size: installer.byteLength,
            browser_download_url: installerUrl,
          },
          {
            name: "SHA256SUMS.txt",
            size: 96,
            browser_download_url: checksumsUrl,
          },
        ],
      }]);
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    }
    if (url === checksumsUrl) {
      const body = `${digest}  Inertia.Setup.0.0.47.exe\n`;
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    }
    if (url === installerUrl) {
      return new Response(installer, {
        status: 200,
        headers: { "content-length": String(installer.byteLength) },
      });
    }
    return new Response("unexpected request", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GH_TOKEN", "bounded-test-token");
  try {
    const metadataPath = await main([
      "--current-version", "0.0.48",
      "--channel", "stable",
      "--architecture", "x64",
      "--output-directory", temporaryRoot,
    ]);
    expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
      assetName: "Inertia.Setup.0.0.47.exe",
      currentVersion: "0.0.48",
      sha256: digest,
      version: "0.0.47",
    });
    expect(requests).toEqual([
      {
        accept: "application/vnd.github+json",
        authorization: "Bearer bounded-test-token",
        url: "https://api.github.com/repos/eduardtomas1/inertia/releases?per_page=100",
      },
      {
        accept: "application/octet-stream",
        authorization: "Bearer bounded-test-token",
        url: checksumsUrl,
      },
      {
        accept: "application/octet-stream",
        authorization: "Bearer bounded-test-token",
        url: installerUrl,
      },
    ]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});

test("enforces the release-catalog byte ceiling while streaming", async () => {
  const { main } = await releaseModule();
  const fetchMock = vi.fn(async () => new Response(
    Buffer.alloc(2 * 1_024 * 1_024 + 1, 0x20),
    { status: 200 },
  ));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(main([
      "--current-version", "0.0.48",
      "--channel", "stable",
      "--architecture", "x64",
      "--output-directory", join(tmpdir(), "inertia-unwritten-n-minus-one"),
    ])).rejects.toThrow("response exceeds its bounded size");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("bounds a stalled GitHub connection and aborts its request", async () => {
  const { fetchBoundedText } = await releaseModule();
  let signal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  }));
  try {
    await expect(fetchBoundedText(
      "https://api.github.com/repos/eduardtomas1/inertia/releases",
      1_024,
      "",
      "application/vnd.github+json",
      { bodyTimeoutMs: 100, connectTimeoutMs: 20 },
    )).rejects.toThrow("GitHub connection timed out");
    expect(signal?.aborted).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("bounds a stalled installer body and removes its partial file", async () => {
  const { downloadBoundedFile } = await releaseModule();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "inertia-n-minus-one-timeout-"));
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    signal = init?.signal ?? undefined;
    return new Response(body, {
      headers: { "content-length": "4" },
      status: 200,
    });
  }));
  try {
    await expect(downloadBoundedFile(
      "https://github.com/eduardtomas1/inertia/releases/download/v0.0.47/Inertia.Setup.0.0.47.exe",
      join(temporaryRoot, "installer.exe"),
      4,
      "",
      { bodyTimeoutMs: 20, connectTimeoutMs: 100 },
    )).rejects.toThrow("GitHub response body timed out");
    expect(signal?.aborted).toBe(true);
    expect(await readdir(temporaryRoot)).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    await rm(temporaryRoot, { force: true, recursive: true });
  }
});
