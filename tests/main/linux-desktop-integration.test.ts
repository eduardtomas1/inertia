import { chmod, lstat, mkdir, mkdtemp, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { desktopExecutable, integrateLinuxAppImage } from "../../src/main/linux-desktop-integration";
import { channelConfiguration } from "../../src/main/release-channel";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-desktop-icon-"))); roots.push(root);
  const appImagePath = join(root, "Inertia 100% $special.AppImage");
  await writeFile(appImagePath, Buffer.from("7f454c4602010100414902", "hex"));
  await chmod(appImagePath, 0o755);
  return { platform: "linux" as const, isPackaged: true, appImagePath,
    homeDirectory: root, dataHome: join(root, "data"),
    runtimeIconPath: resolve("resources/icons/512x512.png"), configuration: channelConfiguration("stable") };
}

it.skipIf(process.platform === "win32")("registers a persistent icon and an exact quoted launcher, then follows an AppImage move", async () => {
  const options = await fixture();
  const desktopPath = (await integrateLinuxAppImage(options))!;
  const source = await readFile(desktopPath, "utf8");
  expect(source).toContain("StartupWMClass=dev.inertia.app\n");
  expect(source).toContain(`Exec=/usr/bin/env -- ${desktopExecutable(options.appImagePath)} %U\n`);
  expect(source).toContain(`Icon=${join(options.dataHome, "dev.inertia.app", "icon.png")}\n`);
  expect(await readFile(join(options.dataHome, "dev.inertia.app", "icon.png")))
    .toEqual(await readFile(options.runtimeIconPath));
  const before = await lstat(desktopPath);
  await integrateLinuxAppImage(options);
  expect((await lstat(desktopPath)).mtimeMs).toBe(before.mtimeMs);
  const moved = join(options.homeDirectory, "Inertia.AppImage");
  await writeFile(moved, await readFile(options.appImagePath)); await chmod(moved, 0o755);
  await integrateLinuxAppImage({ ...options, appImagePath: moved });
  expect(await readFile(desktopPath, "utf8")).toContain(`Exec=/usr/bin/env -- ${desktopExecutable(moved)} %U\n`);
});

it.skipIf(process.platform === "win32")("keeps stable and canary desktop identities and icons separate", async () => {
  const options = await fixture();
  const stable = await integrateLinuxAppImage(options);
  const canary = await integrateLinuxAppImage({ ...options, configuration: channelConfiguration("canary") });
  expect(canary).not.toBe(stable);
  expect(await readFile(canary!, "utf8")).toContain("StartupWMClass=dev.inertia.app.desktop.canary\n");
});

it.skipIf(process.platform === "win32")("leaves another integrator's launcher intact", async () => {
  const options = await fixture();
  const applications = join(options.dataHome, "applications"); await mkdir(applications, { recursive: true });
  const path = join(applications, options.configuration.desktopName);
  const custom = "[Desktop Entry]\nName=My Inertia\nExec=custom-launcher\n";
  await writeFile(path, custom);
  expect(await integrateLinuxAppImage(options)).toBeNull();
  expect(await readFile(path, "utf8")).toBe(custom);
});

it.skipIf(process.platform === "win32")("refuses linked integration directories and desktop entries", async () => {
  const options = await fixture();
  const outside = join(options.homeDirectory, "outside"); await mkdir(outside);
  await mkdir(options.dataHome);
  const applications = join(options.dataHome, "applications"); await symlink(outside, applications);
  await expect(integrateLinuxAppImage(options)).rejects.toThrow("direct directories");
  await rm(applications); await mkdir(applications);
  const other = join(outside, "other.desktop"); await writeFile(other, "keep me");
  await symlink(other, join(applications, options.configuration.desktopName));
  await expect(integrateLinuxAppImage(options)).rejects.toThrow();
  expect(await readFile(other, "utf8")).toBe("keep me");
});

it("ignores development and other platforms, and rejects a non-AppImage before registering it", async () => {
  const options = await fixture();
  for (const override of [{ isPackaged: false }, { platform: "win32" as const }, { appImagePath: undefined }]) {
    expect(await integrateLinuxAppImage({ ...options, ...override })).toBeNull();
  }
  await writeFile(options.appImagePath, "not an AppImage");
  await expect(integrateLinuxAppImage(options)).rejects.toThrow("type-2 AppImage");
  await expect(lstat(options.dataHome)).rejects.toMatchObject({ code: "ENOENT" });
});

it("escapes desktop field codes and reserved Exec characters without invoking a shell", () => {
  expect(desktopExecutable('/a b/"$`\\%/app.AppImage'))
    .toBe('"/a b/\\\\"\\\\$\\\\`\\\\\\\\%%/app.AppImage"');
});
