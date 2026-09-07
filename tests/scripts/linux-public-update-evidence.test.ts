import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../scripts/linux-public-update-evidence.mjs")).href;
type Target = { version: string; name: string; size: number; sha256: string };
const evidence = await import(moduleUrl) as {
  validatePublicTarget: (release: unknown, checksums: string, digest: string) => Target;
  verifyPrivateDownloadedTarget: (root: string, target: Target) => Promise<unknown>;
};
const name = "Inertia-0.0.54.AppImage";
const bytes = Buffer.from("synthetic immutable AppImage bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const target = { version: "0.0.54", name, size: bytes.length, sha256: digest };
const checksums = `${digest}  ${name}\n`;
const release = () => ({ tag_name: "v0.0.54", draft: false, prerelease: false, assets: [{
  name, size: bytes.length, browser_download_url: `https://github.com/eduardtomas1/inertia/releases/download/v0.0.54/${name}`,
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
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("scratch public Linux update identity", () => {
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
