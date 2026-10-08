import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it } from "vitest";

import { applicationMenuTemplate } from "../../src/main/application-menu";

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? items(item.submenu as MenuItemConstructorOptions[]) : []),
  ]);
}

describe("application menu", () => {
  it.each(["darwin", "win32", "linux"] as const)(
    "keeps Electron's role menus and moves Close Window off CmdOrCtrl+W on %s",
    (platform) => {
      const template = applicationMenuTemplate(platform);
      const all = items(template);
      const closes = all.filter((item) => item.role === "close");
      expect(closes).toHaveLength(1);
      expect(closes[0]!.accelerator).toBe("Shift+CmdOrCtrl+W");
      expect(all.filter((item) => item.accelerator !== undefined)).toEqual(closes);
      expect(template.map((item) => item.role)).toEqual([
        ...(platform === "darwin" ? ["appMenu"] : []),
        "fileMenu",
        "editMenu",
        "viewMenu",
        "windowMenu",
      ]);
      expect(all.every((item) => item.role !== undefined || item.type === "separator")).toBe(true);
    },
  );

  it("matches Electron's default File and Window entries per platform", () => {
    const roles = (platform: NodeJS.Platform, menu: string) =>
      (applicationMenuTemplate(platform).find((item) => item.role === menu)!.submenu as MenuItemConstructorOptions[])
        .map((item) => item.role ?? item.type);
    expect(roles("darwin", "fileMenu")).toEqual(["close"]);
    expect(roles("darwin", "windowMenu")).toEqual(["minimize", "zoom", "separator", "front"]);
    expect(roles("linux", "fileMenu")).toEqual(["quit"]);
    expect(roles("win32", "windowMenu")).toEqual(["minimize", "zoom", "close"]);
  });
});
