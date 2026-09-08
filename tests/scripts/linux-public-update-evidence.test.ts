import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../scripts/linux-public-update-evidence.mjs")).href;
type Target = { version: string; name: string; size: number; sha256: string };
const evidence = await import(moduleUrl) as {
  validatePublicTarget: (release: unknown, checksums: string, digest: string, version?: string) => Target;
  downloadPublicTarget: (directory: string, digest: string, version?: string) => Promise<Target>;
  validatePublicUpgrade: (version: string, digest: string, predecessorVersion?: string, predecessorSize?: string, predecessorDigest?: string) => {
    predecessor: Target;
    target: Omit<Target, "size">;
  };
  verifyPrivateDownloadedTarget: (root: string, target: Target) => Promise<unknown>;
};
const name = "Inertia-0.0.54.AppImage";
const bytes = Buffer.from("synthetic immutable AppImage bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const target = { version: "0.0.54", name, size: bytes.length, sha256: digest };
const checksums = `${digest}  ${name}\n`;
const release = (version = "0.0.54") => ({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [{
  name: `Inertia-${version}.AppImage`, size: bytes.length, browser_download_url: `https://github.com/eduardtomas1/inertia/releases/download/v${version}/Inertia-${version}.AppImage`,
  digest: `sha256:${digest}`,
}] });
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-public-update-evidence-"));
  roots.push(root);
  const pending = join(root, "cache", "inertia-updater", "pending");
  await mkdir(pending, { recursive: true });
  await writeFile(join(pending, name), bytes);
  await writeFile(join(pending, "update-info.json"), "{}");
  return { root, pending };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function mockPublicFetch(download = bytes, version = "0.0.54") {
  const expectedName = `Inertia-${version}.AppImage`;
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(new Headers(options.headers).get("authorization")).toBeNull();
    if (url === `https://api.github.com/repos/eduardtomas1/inertia/releases/tags/v${version}`) return new Response(JSON.stringify(release(version)));
    if (url === `https://github.com/eduardtomas1/inertia/releases/download/v${version}/SHA256SUMS.txt`) return new Response(`${digest}  ${expectedName}\n`);
    expect(url).toBe(`https://github.com/eduardtomas1/inertia/releases/download/v${version}/${expectedName}`);
    return new Response(new Uint8Array(download), { headers: { "content-length": String(download.length) } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("scratch public Linux update identity", () => {
  it("requires explicit identities for a consecutive new patch pair", () => {
    const value = evidence.validatePublicUpgrade("0.0.55", digest, "0.0.54", "123", "a".repeat(64));
    expect(value).toEqual({ predecessor: { version: "0.0.54", name: "Inertia-0.0.54.AppImage", size: 123, sha256: "a".repeat(64) },
      target: { version: "0.0.55", name: "Inertia-0.0.55.AppImage", sha256: digest } });
    expect(() => evidence.validatePublicUpgrade("0.0.55", digest)).toThrow();
    expect(evidence.validatePublicUpgrade("0.0.54", digest).predecessor.version).toBe("0.0.53");
  });

  it.each(["0.0.54", "0.0.56", "0.1.0", "1.0.55", "0.0.55-canary", "00.0.55", "../0.0.55", "0.0.1000000"])("rejects a nonconsecutive or unsafe target %s", version => {
    expect(() => evidence.validatePublicUpgrade(version, digest, "0.0.54", "123", "a".repeat(64))).toThrow();
  });

  it.each(["0", "-1", "1e2", "123.5", "536870913", "123/private"])("rejects unbounded predecessor size %s", size => {
    expect(() => evidence.validatePublicUpgrade("0.0.55", digest, "0.0.54", size, "a".repeat(64))).toThrow();
  });

  it("rejects absent, malformed or identical old and new digests", () => {
    expect(() => evidence.validatePublicUpgrade("0.0.55", "", "0.0.54", "123", "a".repeat(64))).toThrow();
    expect(() => evidence.validatePublicUpgrade("0.0.55", digest, "0.0.54", "123", "A".repeat(64))).toThrow();
    expect(() => evidence.validatePublicUpgrade("0.0.55", digest, "0.0.54", "123", digest)).toThrow();
  });

  it("binds the new version to its exact public URLs, metadata, manifest and cache file", async () => {
    const version = "0.0.55", nextName = `Inertia-${version}.AppImage`;
    const nextTarget = { ...target, version, name: nextName };
    const fetch = mockPublicFetch(bytes, version);
    const { root, pending } = await fixture();
    expect(() => evidence.validatePublicTarget(release(), checksums, digest, version)).toThrow();
    expect(() => evidence.validatePublicTarget(release(version), checksums, digest, version)).toThrow();
    await expect(evidence.downloadPublicTarget(join(root, "new-public-target"), digest, version)).resolves.toEqual({
      ...nextTarget, checksumVerified: true, publicArtifact: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(evidence.verifyPrivateDownloadedTarget(root, nextTarget)).rejects.toThrow();
    await rm(join(pending, name));
    await writeFile(join(pending, nextName), bytes);
    await expect(evidence.verifyPrivateDownloadedTarget(root, nextTarget)).resolves.toEqual({
      name: nextName, size: bytes.length, sha256: digest, checksumVerified: true,
    });
  });

  it("downloads only the fixed public target anonymously and rehashes before making it executable", async () => {
    const fetch = mockPublicFetch();
    const { root } = await fixture();
    const directory = join(root, "public-target");
    await expect(evidence.downloadPublicTarget(directory, digest)).resolves.toEqual({
      ...target, checksumVerified: true, publicArtifact: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readFile(join(directory, name))).toEqual(bytes);
    if (process.platform !== "win32") expect((await stat(join(directory, name))).mode & 0o777).toBe(0o755);
    await expect(evidence.downloadPublicTarget(directory, digest)).rejects.toThrow();
    expect(await readFile(join(directory, name))).toEqual(bytes);
  });

  it("refuses public bytes that disagree with their metadata and manifest", async () => {
    mockPublicFetch(Buffer.alloc(bytes.length));
    const { root } = await fixture();
    const directory = join(root, "public-target");
    await expect(evidence.downloadPublicTarget(directory, digest)).rejects.toThrow();
    if (process.platform !== "win32") expect((await stat(join(directory, name))).mode & 0o111).toBe(0);
  });

  it("requires matching release metadata, manifest and externally expected digest", () => {
    expect(evidence.validatePublicTarget(release(), checksums, digest)).toEqual(target);
    expect(() => evidence.validatePublicTarget(release(), checksums, "b".repeat(64))).toThrow();
    expect(() => evidence.validatePublicTarget(release(), `${"b".repeat(64)}  ${name}\n`, digest)).toThrow();
    expect(() => evidence.validatePublicTarget(release(), checksums + checksums, digest)).toThrow();
  });

  it.each(["wrong-tag", "draft", "prerelease", "duplicate", "wrong-url", "oversized", "unbound-digest"])("rejects %s target metadata", reason => {
    const value = release();
    if (reason === "wrong-tag") value.tag_name = "v0.0.55";
    if (reason === "draft") value.draft = true;
    if (reason === "prerelease") value.prerelease = true;
    if (reason === "duplicate") value.assets.push({ ...value.assets[0] });
    if (reason === "wrong-url") value.assets[0].browser_download_url = "https://example.com/unknown.AppImage";
    if (reason === "oversized") value.assets[0].size = 512 * 1024 * 1024 + 1;
    if (reason === "unbound-digest") value.assets[0].digest = "sha256:" + "b".repeat(64);
    expect(() => evidence.validatePublicTarget(value, checksums, digest)).toThrow();
  });

  it("hashes only the one completed target under the private updater cache", async () => {
    const { root } = await fixture();
    expect(await evidence.verifyPrivateDownloadedTarget(root, target)).toEqual({
      name, size: bytes.length, sha256: digest, checksumVerified: true,
    });
  });

  it("rejects different bytes or a truncated download", async () => {
    const { root, pending } = await fixture();
    await expect(evidence.verifyPrivateDownloadedTarget(root, { ...target, sha256: "b".repeat(64) })).rejects.toThrow();
    await writeFile(join(pending, name), bytes.subarray(1));
    await expect(evidence.verifyPrivateDownloadedTarget(root, target)).rejects.toThrow();
  });

  it("bounds directory entries and rejects ambiguous AppImages", async () => {
    const { root, pending } = await fixture();
    await writeFile(join(pending, "different.AppImage"), bytes);
    await expect(evidence.verifyPrivateDownloadedTarget(root, target)).rejects.toThrow();
    await rm(join(pending, "different.AppImage"));
    for (let index = 0; index < 17; index++) await writeFile(join(pending, `other-${index}`), "");
    await expect(evidence.verifyPrivateDownloadedTarget(root, target)).rejects.toThrow("entry limit");
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked candidate or cache ancestor", async () => {
    const { root, pending } = await fixture();
    const outside = join(root, "outside");
    await writeFile(outside, bytes);
    await rm(join(pending, name));
    await symlink(outside, join(pending, name));
    await expect(evidence.verifyPrivateDownloadedTarget(root, target)).rejects.toThrow();
    await rm(join(root, "cache"), { recursive: true });
    await mkdir(join(root, "other-cache"));
    await symlink(join(root, "other-cache"), join(root, "cache"));
    await expect(evidence.verifyPrivateDownloadedTarget(root, target)).rejects.toThrow();
  });
});
