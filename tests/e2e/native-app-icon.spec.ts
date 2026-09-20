// @inertia-e2e-resource isolated
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createAppFixture } from "./support/app-fixture";

test("supplies native Windows taskbar and window icons at the system sizes", async (_fixtures, testInfo) => {
  test.skip(process.platform !== "win32", "Inspects real Windows HICONs.");
  const fixture = await createAppFixture({ name: "native-app-icon", initialState: "empty" });
  try {
    const handle = await fixture.electronApp.evaluate(({ BrowserWindow }) => {
      const buffer = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
      return buffer.length === 8 ? buffer.readBigUInt64LE().toString(16) : buffer.readUInt32LE().toString(16);
    });
    const { stdout } = await promisify(execFile)("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", resolve("tests/fixtures/native-icons/read-window-icons.ps1"),
      "-WindowHandle", handle, "-IconPath", resolve("resources/icon.ico"),
    ], { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
    const icons = JSON.parse(stdout) as Array<{
      requestedSize: number; actual: { width: number; height: number; sha256: string };
      expected: { width: number; height: number; sha256: string };
    }>;
    await testInfo.attach("native-window-icons.json", { body: stdout, contentType: "application/json" });
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon.actual.width).toBe(icon.requestedSize);
      expect(icon.actual.height).toBe(icon.requestedSize);
      expect(icon.actual).toEqual(icon.expected);
    }
  } finally {
    await fixture.close();
  }
});
