// @inertia-test-suite portable

import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { requestLinuxSingletonLaunch } from "../../src/main/linux-singleton-launch";
import type { InertiaReleaseChannel } from "../../src/main/release-channel";

const pid = 314159;
const executable = "/tmp/.mount_Inertia/inertia";
const profileDirectory = "/profiles/stable";
const lockPath = join(profileDirectory, "SingletonLock");
const manifestPath = join("/tmp/.mount_Inertia", "resources", "app.asar", "package.json");

function processStat(birth = "1234"): string {
  return `${pid} (inertia) S 1 ${pid} ${Array<string>(16).fill("0").join(" ")} ${birth} 0`;
}

function fixture(version = "0.0.47") {
  const files = new Map([
    [`/proc/${pid}/stat`, processStat()],
    [`/proc/${pid}/cmdline`, `${executable}\0--no-sandbox\0`],
    [manifestPath, JSON.stringify({
      name: "inertia", main: "out/main/index.js", inertiaReleaseChannel: "stable", version,
    })],
  ]);
  const links = new Map([[lockPath, `test-host-${pid}`], [`/proc/${pid}/exe`, executable]]);
  const readLink = vi.fn((path: string): string => {
    const value = links.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  });
  const readText = vi.fn((path: string, maxBytes: number): string => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    if (Buffer.byteLength(value) > maxBytes) throw new Error("oversized");
    return value;
  });
  let clock = 0;
  const wait = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
  const requestLock = vi.fn(() => false);
  const reportContention = vi.fn();
  return {
    files, links, requestLock, reportContention,
    options: { profileDirectory, channel: "stable" as InertiaReleaseChannel, version: "0.0.52", requestLock, reportContention },
    inspection: {
      readLink, readText, realPath: (path: string) => path,
      readManifest: (archivePath: string, maxBytes: number) => readText(join(archivePath, "package.json"), maxBytes),
      processUser: vi.fn(() => 1000), hostname: "test-host", uid: 1000,
      wait, now: () => clock,
    },
  };
}

describe("Linux ordinary AppImage singleton launch", () => {
  it("starts normally when Electron grants the singleton", async () => {
    const test = fixture();
    test.requestLock.mockReturnValue(true);
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(true);
    expect(test.requestLock).toHaveBeenCalledOnce();
    expect(test.inspection.wait).not.toHaveBeenCalled();
    expect(test.reportContention).not.toHaveBeenCalled();
  });

  it("preserves immediate, silent same-version activation", async () => {
    const test = fixture("0.0.52");
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(false);
    expect(test.requestLock).toHaveBeenCalledOnce();
    expect(test.inspection.wait).not.toHaveBeenCalled();
    expect(test.reportContention).not.toHaveBeenCalled();
  });

  it("waits a bounded interval for a different version without repeated focus notifications", async () => {
    const test = fixture();
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(false);
    expect(test.requestLock).toHaveBeenCalledOnce();
    expect(test.inspection.now()).toBe(5_000);
    expect(test.reportContention).toHaveBeenCalledExactlyOnceWith({
      requestedVersion: "0.0.52", runningVersion: "0.0.47",
    });
  });

  it("continues the selected launch if the notified owner exits immediately", async () => {
    const test = fixture();
    test.requestLock.mockImplementationOnce(() => {
      test.files.delete(`/proc/${pid}/stat`);
      return false;
    }).mockReturnValueOnce(true);
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(true);
    expect(test.requestLock).toHaveBeenCalledTimes(2);
    expect(test.inspection.wait).not.toHaveBeenCalled();
    expect(test.reportContention).not.toHaveBeenCalled();
  });

  it("continues after an owner releases its singleton during its own cleanup", async () => {
    const test = fixture();
    test.inspection.wait.mockImplementationOnce(async () => { test.links.delete(lockPath); });
    test.requestLock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(true);
    expect(test.requestLock).toHaveBeenCalledTimes(2);
    expect(test.inspection.wait).toHaveBeenCalledOnce();
    expect(test.reportContention).not.toHaveBeenCalled();
  });

  it("observes an owner exit at the launch grace deadline", async () => {
    const test = fixture();
    const original = test.inspection.wait.getMockImplementation()!;
    test.inspection.wait.mockImplementation(async (milliseconds) => {
      await original(milliseconds);
      if (test.inspection.now() === 5_000) test.files.delete(`/proc/${pid}/stat`);
    });
    test.requestLock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(true);
    expect(test.requestLock).toHaveBeenCalledTimes(2);
    expect(test.inspection.now()).toBe(5_000);
    expect(test.reportContention).not.toHaveBeenCalled();
  });

  it("never bootstraps if a competing launcher wins after the observed owner exits", async () => {
    const test = fixture();
    test.inspection.wait.mockImplementationOnce(async () => { test.files.delete(`/proc/${pid}/stat`); });
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(false);
    expect(test.requestLock).toHaveBeenCalledTimes(2);
    expect(test.reportContention).toHaveBeenCalledExactlyOnceWith({
      requestedVersion: "0.0.52", runningVersion: null,
    });
  });

  it.each(["pid-reuse", "new-lock", "exec-change", "permission"])(
    "stops waiting without retrying when owner identity changes: %s", async (change) => {
      const test = fixture();
      test.inspection.wait.mockImplementationOnce(async () => {
        if (change === "pid-reuse") test.files.set(`/proc/${pid}/stat`, processStat("9999"));
        if (change === "new-lock") test.links.set(lockPath, "test-host-271828");
        if (change === "exec-change") test.links.set(`/proc/${pid}/exe`, "/other/inertia");
        if (change === "permission") test.inspection.readText.mockImplementation(() => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        });
      });
      expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(false);
      expect(test.requestLock).toHaveBeenCalledOnce();
      expect(test.reportContention).toHaveBeenCalledExactlyOnceWith({
        requestedVersion: "0.0.52", runningVersion: null,
      });
    },
  );

  it.each(["foreign-host", "foreign-user", "wrapper", "renderer", "manifest", "channel", "symlink", "oversized"])(
    "reports an unknown owner without authorizing recovery from %s", async (invalid) => {
      const test = fixture();
      if (invalid === "foreign-host") test.links.set(lockPath, `other-host-${pid}`);
      if (invalid === "foreign-user") test.inspection.processUser.mockReturnValue(2000);
      if (invalid === "wrapper") test.links.set(`/proc/${pid}/exe`, "/downloads/Inertia.AppImage");
      if (invalid === "renderer") test.files.set(`/proc/${pid}/cmdline`, `${executable}\0--type=renderer\0`);
      if (invalid === "manifest") test.files.set(manifestPath, JSON.stringify({ name: "other", version: "0.0.47" }));
      if (invalid === "channel") test.options.channel = "canary";
      if (invalid === "symlink") test.inspection.realPath = () => "/somewhere/else/inertia";
      if (invalid === "oversized") test.files.set(manifestPath, " ".repeat(65_537));
      expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(false);
      expect(test.requestLock).toHaveBeenCalledOnce();
      expect(test.inspection.wait).not.toHaveBeenCalled();
      expect(test.reportContention).toHaveBeenCalledExactlyOnceWith({
        requestedVersion: "0.0.52", runningVersion: null,
      });
    },
  );

  it("does not trust a process whose birth identity changes during manifest inspection", async () => {
    const test = fixture();
    const original = test.inspection.readText.getMockImplementation()!;
    test.inspection.readText.mockImplementation((path, limit) => {
      if (path === manifestPath) test.files.set(`/proc/${pid}/stat`, processStat("9999"));
      return original(path, limit);
    });
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(false);
    expect(test.inspection.wait).not.toHaveBeenCalled();
    expect(test.reportContention).toHaveBeenCalledWith({ requestedVersion: "0.0.52", runningVersion: null });
  });

  it("recognizes Electron's flattened Linux main command line", async () => {
    const test = fixture();
    test.files.set(`/proc/${pid}/cmdline`, `${executable} --no-sandbox --user-data-dir=/tmp/profile with spaces\0`);
    await expect(requestLinuxSingletonLaunch(test.options, test.inspection)).resolves.toBe(false);
    expect(test.reportContention).toHaveBeenCalledWith({ requestedVersion: "0.0.52", runningVersion: "0.0.47" });
  });

  it.each([
    `${executable}-wrapper --no-sandbox\0`,
    `${executable} --type=renderer\0`,
    `${executable} --type utility\0`,
    `${executable} --no-sandbox\0--type=renderer\0`,
  ])("rejects an ambiguous or child flattened command line %s", async (cmdline) => {
    const test = fixture();
    test.files.set(`/proc/${pid}/cmdline`, cmdline);
    await expect(requestLinuxSingletonLaunch(test.options, test.inspection)).resolves.toBe(false);
    expect(test.inspection.wait).not.toHaveBeenCalled();
    expect(test.reportContention).toHaveBeenCalledWith({ requestedVersion: "0.0.52", runningVersion: null });
  });

  it("waits for the contention notice to close before the launcher exits", async () => {
    const test = fixture();
    test.links.clear();
    let dismiss!: () => void;
    const notice = vi.fn(() => new Promise<void>((resolve) => { dismiss = resolve; }));
    let finished = false;
    const launch = requestLinuxSingletonLaunch({ ...test.options, reportContention: notice }, test.inspection)
      .then((result) => { finished = true; return result; });
    await Promise.resolve();
    expect(notice).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    dismiss();
    expect(await launch).toBe(false);
  });

  it("still refuses startup when the native contention notice rejects", async () => {
    const test = fixture();
    test.links.clear();
    await expect(requestLinuxSingletonLaunch({
      ...test.options, reportContention: async () => { throw new Error("native dialog unavailable"); },
    }, test.inspection)).resolves.toBe(false);
    expect(test.requestLock).toHaveBeenCalledOnce();
  });

  it("also bounds polling if the clock moves backward", async () => {
    const test = fixture();
    test.inspection.now = () => 0;
    expect(await requestLinuxSingletonLaunch(test.options, test.inspection)).toBe(false);
    expect(test.inspection.wait).toHaveBeenCalledTimes(50);
    expect(test.requestLock).toHaveBeenCalledOnce();
  });
});
