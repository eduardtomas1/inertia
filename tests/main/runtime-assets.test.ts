import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveRuntimeIconPath,
  resolveRuntimeProcessGuardianPath,
  resolveWindowsRuntimeJobAssemblyPath,
} from "../../src/main/runtime-assets";

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

describe("runtime process guardian resolution", () => {
  it("uses an explicit extraResources executable in packaged builds", () => {
    expect(resolveRuntimeProcessGuardianPath({
      isPackaged: true,
      resourcesPath: "/opt/Inertia/resources",
      appPath: "/opt/Inertia/resources/app.asar",
    })).toBe(join(
      resolve("/opt/Inertia/resources"),
      "runtime",
      "runtime-process-guardian",
    ));
  });

  it("uses the generated source executable during development", () => {
    expect(resolveRuntimeProcessGuardianPath({
      isPackaged: false,
      resourcesPath: "/ignored",
      appPath: "/work/inertia",
    })).toBe(join(
      resolve("/work/inertia"),
      "resources",
      "generated",
      "runtime-process-guardian",
      "runtime-process-guardian",
    ));
  });
});

describe("Windows runtime Job Object assembly resolution", () => {
  it("uses the explicit extraResources assembly in packaged builds", () => {
    expect(resolveWindowsRuntimeJobAssemblyPath({
      isPackaged: true,
      resourcesPath: "C:\\Program Files\\Inertia\\resources",
      appPath: "C:\\Program Files\\Inertia\\resources\\app.asar",
    })).toBe(join(
      resolve("C:\\Program Files\\Inertia\\resources"),
      "runtime",
      "windows-runtime-job.exe",
    ));
  });

  it("uses the generated assembly during development", () => {
    expect(resolveWindowsRuntimeJobAssemblyPath({
      isPackaged: false,
      resourcesPath: "/ignored",
      appPath: "/work/inertia",
    })).toBe(join(
      resolve("/work/inertia"),
      "resources",
      "generated",
      "runtime-process-guardian",
      "windows-runtime-job.exe",
    ));
  });
});
