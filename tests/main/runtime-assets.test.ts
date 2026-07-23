import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRuntimeIconPath } from "../../src/main/runtime-assets";

describe("runtime icon resolution", () => {
  it("uses an explicit extraResources icon in packaged builds", () => {
    expect(resolveRuntimeIconPath({
      isPackaged: true,
      resourcesPath: "/opt/Inertia/resources",
      appPath: "/opt/Inertia/resources/app.asar",
    })).toBe(join(resolve("/opt/Inertia/resources"), "icons", "inertia.png"));
  });

  it("uses the generated source icon during development", () => {
    expect(resolveRuntimeIconPath({
      isPackaged: false,
      resourcesPath: "/ignored",
      appPath: "/work/inertia",
    })).toBe(join(resolve("/work/inertia"), "resources", "icons", "512x512.png"));
  });
});
