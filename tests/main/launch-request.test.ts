import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DETACHED_LAUNCH_ENVIRONMENT,
  detachedRelaunchPlan,
  LaunchRequestQueue,
  newChatLaunchRequest,
  relaunchDetached,
} from "../../src/main/launch-request";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("new chat launch requests", () => {
  it("reads --new-chat with no path, a relative path, an absolute path or the = form", () => {
    const cwd = resolve("/work/app");
    expect(newChatLaunchRequest(["/opt/Inertia", "--new-chat"], cwd)).toMatchObject({ path: cwd });
    expect(newChatLaunchRequest(["/opt/Inertia", "--new-chat", "--foreground"], cwd)).toMatchObject({ path: cwd });
    expect(newChatLaunchRequest(["/opt/Inertia", "--new-chat", "packages/web"], cwd)).toMatchObject({ path: resolve(cwd, "packages/web") });
    expect(newChatLaunchRequest(["/opt/Inertia", "--new-chat", resolve("/srv/site")], cwd)).toMatchObject({ path: resolve("/srv/site") });
    expect(newChatLaunchRequest(["/opt/Inertia", "--new-chat=../other"], cwd)).toMatchObject({ path: resolve("/work/other") });
    expect(newChatLaunchRequest(["/opt/Inertia", "--new-chat="], cwd)).toMatchObject({ path: cwd });
  });

  it("ignores launches without the flag", () => {
    expect(newChatLaunchRequest(["/opt/Inertia", "--no-sandbox", "."], "/work/app")).toBeNull();
    expect(newChatLaunchRequest(["/opt/Inertia", "--new-chats"], "/work/app")).toBeNull();
  });

  it("resolves the real folder behind a symbolic link and leaves it empty for a missing folder", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-launch-"));
    directories.push(root);
    symlinkSync(root, join(root, "linked"));
    expect(newChatLaunchRequest(["--new-chat", "linked"], root)).toEqual({ path: join(root, "linked"), realPath: realpathSync(root) });
    expect(newChatLaunchRequest(["--new-chat", "missing"], root)).toEqual({ path: join(root, "missing"), realPath: null });
  });

  it("keeps one pending request per folder, tells the window, and hands them over once", () => {
    const notify = vi.fn();
    const queue = new LaunchRequestQueue(notify);
    queue.add(null);
    expect(notify).not.toHaveBeenCalled();
    queue.add({ path: "/a", realPath: "/a" });
    queue.add({ path: "/b", realPath: null });
    queue.add({ path: "/a", realPath: "/a" });
    expect(notify).toHaveBeenCalledTimes(3);
    expect(queue.take()).toEqual([{ path: "/b", realPath: null }, { path: "/a", realPath: "/a" }]);
    expect(queue.take()).toEqual([]);
  });
});

describe("detached launch from a terminal", () => {
  const base = {
    platform: "linux" as NodeJS.Platform,
    isPackaged: true,
    attachedToTerminal: true,
    argv: ["/tmp/.mount_Inertia/inertia", "--no-sandbox", "--new-chat", "."],
    execPath: "/tmp/.mount_Inertia/inertia",
    environment: { APPIMAGE: "/home/user/Inertia.AppImage" } as NodeJS.ProcessEnv,
  };

  it("relaunches the AppImage itself without the sandbox switch AppRun adds again", () => {
    expect(detachedRelaunchPlan(base)).toEqual({ command: "/home/user/Inertia.AppImage", args: ["--new-chat", "."] });
  });

  it("relaunches the app binary on macOS", () => {
    expect(detachedRelaunchPlan({ ...base, platform: "darwin", environment: {}, execPath: "/Applications/Inertia.app/Contents/MacOS/Inertia", argv: ["/Applications/Inertia.app/Contents/MacOS/Inertia", "--new-chat"] }))
      .toEqual({ command: "/Applications/Inertia.app/Contents/MacOS/Inertia", args: ["--new-chat"] });
  });

  it.each([
    ["a development build", { isPackaged: false }],
    ["a launch without a terminal", { attachedToTerminal: false }],
    ["Windows", { platform: "win32" as NodeJS.Platform }],
    ["an already detached launch", { environment: { APPIMAGE: "/x", [DETACHED_LAUNCH_ENVIRONMENT]: "1" } }],
    ["an app update candidate", { environment: { APPIMAGE: "/x", INERTIA_APP_UPDATE_CANDIDATE_MODE: "restricted" } }],
    ["--foreground", { argv: ["/tmp/.mount_Inertia/inertia", "--foreground"] }],
    ["an AppImage extracted instead of mounted", { execPath: "/tmp/appimage_extracted_0a1b2c/inertia" }],
  ])("stays in the foreground for %s", (_name, override) => {
    expect(detachedRelaunchPlan({ ...base, ...override })).toBeNull();
  });

  it("reports whether the detached process started", async () => {
    await expect(relaunchDetached({ command: process.execPath, args: ["-e", ""] }, process.env, process.cwd())).resolves.toBe(true);
    await expect(relaunchDetached({ command: "/nonexistent/inertia-launcher", args: [] }, process.env, process.cwd())).resolves.toBe(false);
  });
});
