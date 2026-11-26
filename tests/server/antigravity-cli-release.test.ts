import { describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_CLI_MANIFEST_BASE,
  antigravityCliTarget,
  antigravityManifestUrl,
  fetchLatestAntigravityRelease,
  parseAntigravityCliRelease,
} from "../../src/server/provider/antigravity-cli-release";

const VALID_SHA512 = "a".repeat(128);
const UPPER_SHA512 = "ABCDEF0123456789".repeat(8);

const OFFICIAL_TARGETS = [
  {
    platform: "darwin" as const,
    arch: "arm64",
    musl: false,
    target: "darwin_arm64",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/darwin-arm/cli_mac_arm64.tar.gz",
    executableName: "antigravity",
    format: "tar.gz" as const,
  },
  {
    platform: "darwin" as const,
    arch: "x64",
    musl: false,
    target: "darwin_amd64",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/darwin-x64/cli_mac_x64.tar.gz",
    executableName: "antigravity",
    format: "tar.gz" as const,
  },
  {
    platform: "linux" as const,
    arch: "x64",
    musl: false,
    target: "linux_amd64",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/linux-x64/cli_linux_x64.tar.gz",
    executableName: "antigravity",
    format: "tar.gz" as const,
  },
  {
    platform: "linux" as const,
    arch: "x64",
    musl: true,
    target: "linux_amd64_musl",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/linux-x64-musl/cli_linux_x64_musl.tar.gz",
    executableName: "antigravity",
    format: "tar.gz" as const,
  },
  {
    platform: "linux" as const,
    arch: "arm64",
    musl: false,
    target: "linux_arm64",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/linux-arm/cli_linux_arm64.tar.gz",
    executableName: "antigravity",
    format: "tar.gz" as const,
  },
  {
    platform: "linux" as const,
    arch: "arm64",
    musl: true,
    target: "linux_arm64_musl",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/linux-arm-musl/cli_linux_arm64_musl.tar.gz",
    executableName: "antigravity",
    format: "tar.gz" as const,
  },
  {
    platform: "win32" as const,
    arch: "x64",
    musl: false,
    target: "windows_amd64",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/windows-x64/cli_windows_x64.exe",
    executableName: "agy.exe",
    format: "executable" as const,
  },
  {
    platform: "win32" as const,
    arch: "arm64",
    musl: false,
    target: "windows_arm64",
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-123456/windows-arm/cli_windows_arm64.exe",
    executableName: "agy.exe",
    format: "executable" as const,
  },
];

describe("antigravity-cli-release", () => {
  it.each(OFFICIAL_TARGETS)(
    "resolves target, manifest URL, and release asset for $target",
    ({ platform, arch, musl, target, url, executableName, format }) => {
      expect(antigravityCliTarget(platform, arch, musl)).toBe(target);
      expect(antigravityManifestUrl(platform, arch, musl)).toBe(
        `${ANTIGRAVITY_CLI_MANIFEST_BASE}/${target}.json`,
      );
      expect(
        parseAntigravityCliRelease(
          { version: "1.5.18", url, sha512: UPPER_SHA512 },
          platform,
          arch,
          musl,
        ),
      ).toEqual({
        version: "1.5.18",
        url,
        sha512: UPPER_SHA512.toLowerCase(),
        executableName,
        format,
      });
    },
  );

  it("returns null for unsupported platforms and architectures", () => {
    expect(antigravityCliTarget("freebsd", "x64")).toBeNull();
    expect(antigravityCliTarget("linux", "ia32")).toBeNull();
    expect(antigravityCliTarget("win32", "ia32")).toBeNull();
    expect(antigravityManifestUrl("freebsd", "x64")).toBeNull();
    expect(
      parseAntigravityCliRelease(
        {
          version: "1.5.18",
          url: OFFICIAL_TARGETS[2]!.url,
          sha512: VALID_SHA512,
        },
        "freebsd",
        "x64",
      ),
    ).toBeNull();
  });

  it("rejects untrusted hosts, mismatched targets, path traversal, and invalid checksums", () => {
    const valid = {
      version: "1.5.18",
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-99/linux-x64/cli_linux_x64.tar.gz",
      sha512: VALID_SHA512,
    };

    expect(parseAntigravityCliRelease(valid, "linux", "x64", false)).not.toBeNull();

    // Untrusted hosts and schemes
    expect(parseAntigravityCliRelease({
      ...valid,
      url: "https://evil.example/antigravity-public/antigravity-cli/1.5.18-99/linux-x64/cli_linux_x64.tar.gz",
    }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({
      ...valid,
      url: "http://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-99/linux-x64/cli_linux_x64.tar.gz",
    }, "linux", "x64", false)).toBeNull();

    // Wrong platform / arch / musl
    expect(parseAntigravityCliRelease(valid, "darwin", "arm64", false)).toBeNull();
    expect(parseAntigravityCliRelease(valid, "linux", "x64", true)).toBeNull();
    expect(parseAntigravityCliRelease(valid, "linux", "arm64", false)).toBeNull();
    expect(parseAntigravityCliRelease(valid, "win32", "x64", false)).toBeNull();

    // Mismatched version or build segment
    expect(parseAntigravityCliRelease({
      ...valid,
      version: "1.5.19",
    }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({
      ...valid,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-abc/linux-x64/cli_linux_x64.tar.gz",
    }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({
      ...valid,
      url: `${valid.url}?token=secret`,
    }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({
      ...valid,
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-99/../linux-x64/cli_linux_x64.tar.gz",
    }, "linux", "x64", false)).toBeNull();

    // Invalid versions and checksums
    expect(parseAntigravityCliRelease({ ...valid, version: "v1.5.18" }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({ ...valid, version: "1.5" }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({ ...valid, sha512: "a".repeat(127) }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({ ...valid, sha512: "a".repeat(129) }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease({ ...valid, sha512: "g".repeat(128) }, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease(null, "linux", "x64", false)).toBeNull();
    expect(parseAntigravityCliRelease([], "linux", "x64", false)).toBeNull();
  });

  it("fetches and validates the official manifest with strict redirect and size bounds", async () => {
    const manifestPayload = {
      version: "1.5.18",
      url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.18-42/linux-x64/cli_linux_x64.tar.gz",
      sha512: VALID_SHA512,
    };
    const mockFetch = vi.fn(async () => new Response(JSON.stringify(manifestPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const release = await fetchLatestAntigravityRelease({
      fetch: mockFetch as typeof fetch,
      platform: "linux",
      arch: "x64",
      musl: false,
    });

    expect(release).toEqual({
      version: "1.5.18",
      url: manifestPayload.url,
      sha512: VALID_SHA512,
      executableName: "antigravity",
      format: "tar.gz",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      `${ANTIGRAVITY_CLI_MANIFEST_BASE}/linux_amd64.json`,
      expect.objectContaining({
        redirect: "error",
        headers: { accept: "application/json" },
      }),
    );
  });

  it("rejects oversized, malformed, and HTTP-error responses without leaking URLs", async () => {
    const declaredHuge = new Response("{}", {
      status: 200,
      headers: { "content-length": String(65 * 1024) },
    });
    const streamedHuge = new Response("x".repeat(65 * 1024), { status: 200 });
    const badJson = new Response("not-json", { status: 200 });
    const badManifest = new Response(JSON.stringify({
      version: "1.5.18",
      url: "https://evil.example/cli.tar.gz",
      sha512: VALID_SHA512,
    }), { status: 200 });
    const notFound = new Response("missing", { status: 404 });

    for (const response of [declaredHuge, streamedHuge, badJson, badManifest, notFound]) {
      const mockFetch = vi.fn(async () => response);
      await expect(fetchLatestAntigravityRelease({
        fetch: mockFetch as typeof fetch,
        platform: "linux",
        arch: "x64",
        musl: false,
      })).rejects.toThrow(/^Antigravity CLI release manifest/u);
    }

    const unsupportedFetch = vi.fn();
    await expect(fetchLatestAntigravityRelease({
      fetch: unsupportedFetch as typeof fetch,
      platform: "freebsd",
      arch: "x64",
    })).rejects.toThrow("not available for this platform");
    expect(unsupportedFetch).not.toHaveBeenCalled();
  });

  it("propagates caller abort and maps timeout to AbortError", async () => {
    const controller = new AbortController();
    const hangingFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }));

    const cancelledPromise = fetchLatestAntigravityRelease({
      fetch: hangingFetch as typeof fetch,
      platform: "darwin",
      arch: "arm64",
      signal: controller.signal,
    });
    controller.abort(new Error("user cancelled"));
    await expect(cancelledPromise).rejects.toThrow("user cancelled");

    await expect(fetchLatestAntigravityRelease({
      fetch: hangingFetch as typeof fetch,
      platform: "darwin",
      arch: "arm64",
      timeoutMs: 250,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
