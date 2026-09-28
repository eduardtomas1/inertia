import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeSourceArchitecture } from "../../scripts/architecture/analyzer.mjs";

const roots: string[] = [];

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-architecture-analyzer-"));
  roots.push(root);
  const config = JSON.stringify({
    compilerOptions: {
      paths: {
        "@/*": ["./src/renderer/src/*"],
        "@shared/*": ["./src/shared/*"],
      },
    },
  });
  writeFileSync(join(root, "tsconfig.node.json"), config);
  writeFileSync(join(root, "tsconfig.web.json"), config);
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function linkDirectory(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function linkFile(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, "file");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("architecture analyzer asset imports", () => {
  it("applies source layer rules to asset imports, including queries and aliases", () => {
    const root = fixture({
      "src/renderer/src/assets/art.png": "png",
      "src/renderer/src/assets/other.webp": "webp",
      "src/shared/assets/shared.png": "png",
      "src/main/sprites.ts": [
        'import art from "../renderer/src/assets/art.png?inline";',
        'import shared from "../shared/assets/shared.png?inline";',
        "export const sprites = [art, shared];",
        "",
      ].join("\n"),
      "src/shared/art.ts": [
        'import other from "@/assets/other.webp";',
        "export const art = other;",
        "",
      ].join("\n"),
      "src/renderer/src/view.ts": [
        'import art from "./assets/art.png";',
        'import shared from "@shared/assets/shared.png";',
        "export const view = [art, shared];",
        "",
      ].join("\n"),
    });

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/main/sprites.ts:1 crosses source layers main -> renderer via src/renderer/src/assets/art.png.",
      "src/shared/art.ts:1 crosses source layers shared -> renderer via src/renderer/src/assets/other.webp.",
    ]);
  });

  it("allows only the reviewed importer and asset directory", () => {
    const root = fixture({
      "src/renderer/src/assets/mascot/idle.png": "png",
      "src/renderer/src/assets/icons/app.png": "png",
      "src/main/sprites.ts": [
        'import idle from "../renderer/src/assets/mascot/idle.png?inline";',
        'import app from "../renderer/src/assets/icons/app.png?inline";',
        "export const sprites = [idle, app];",
        "",
      ].join("\n"),
      "src/main/other.ts": [
        'import idle from "../renderer/src/assets/mascot/idle.png?inline";',
        "export const other = idle;",
        "",
      ].join("\n"),
    });

    expect(analyzeSourceArchitecture({
      workspaceRoot: root,
      allowedAssetImports: [{ from: "src/main/sprites.ts", directory: "src/renderer/src/assets/mascot" }],
    }).failures).toEqual([
      "src/main/other.ts:1 crosses source layers main -> renderer via src/renderer/src/assets/mascot/idle.png.",
      "src/main/sprites.ts:2 crosses source layers main -> renderer via src/renderer/src/assets/icons/app.png.",
    ]);
  });
});

describe("architecture analyzer symbolic links", () => {
  it.skipIf(process.platform === "win32")("classifies a symbolic-linked asset by the layer of its real target", () => {
    const root = fixture({
      "src/renderer/src/assets/art.png": "png",
      "src/shared/icon.ts": 'import art from "./art.png";\nexport const icon = art;\n',
    });
    linkFile(join(root, "src/renderer/src/assets/art.png"), join(root, "src/shared/art.png"));

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/shared/icon.ts:1 crosses source layers shared -> renderer via src/renderer/src/assets/art.png.",
    ]);
  });

  it("classifies assets and modules below a symbolic-linked directory by their real layer", () => {
    const root = fixture({
      "src/renderer/src/assets/art.png": "png",
      "src/renderer/src/ui/view.ts": 'import { useState } from "react";\nexport const view = useState;\n',
      "src/main/sprites.ts": 'import art from "./assets/art.png?inline";\nexport const sprites = [art];\n',
      "src/shared/consumer.ts": 'import { view } from "./ui/view";\nexport const consumer = view;\n',
    });
    linkDirectory(join(root, "src/renderer/src/assets"), join(root, "src/main/assets"));
    linkDirectory(join(root, "src/renderer/src/ui"), join(root, "src/shared/ui"));

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/main/sprites.ts:1 crosses source layers main -> renderer via src/renderer/src/assets/art.png.",
      "src/shared/consumer.ts:1 crosses source layers shared -> renderer via src/renderer/src/ui/view.ts.",
    ]);
  });

  it("rejects source files and assets that resolve outside the repository", () => {
    const outside = mkdtempSync(join(tmpdir(), "inertia-architecture-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "art.png"), "png");
    writeFileSync(join(outside, "code.ts"), "export const code = true;\n");
    const root = fixture({
      "src/shared/icon.ts": 'import art from "./external/art.png";\nexport const icon = art;\n',
    });
    linkDirectory(outside, join(root, "src/shared/external"));

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/shared/external/code.ts resolves outside the repository.",
      "src/shared/icon.ts:1 imports asset ./external/art.png, which resolves outside the repository.",
    ]);
  });

  it("rejects source files linked from elsewhere in the repository and missing assets", () => {
    const root = fixture({
      "tests/helpers/fixture.ts": "export const fixture = true;\n",
      "src/shared/icon.ts": 'import art from "./missing.png";\nexport const icon = art;\n',
    });
    linkDirectory(join(root, "tests/helpers"), join(root, "src/shared/helpers"));

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/shared/helpers/fixture.ts resolves to tests/helpers/fixture.ts outside src.",
      "src/shared/icon.ts:1 cannot resolve local asset ./missing.png.",
    ]);
  });

  it.skipIf(process.platform === "win32")("keeps symbolic-linked TypeScript files unresolved", () => {
    const root = fixture({
      "src/renderer/src/view.ts": "export const view = true;\n",
      "src/shared/consumer.ts": 'import { view } from "./view";\nexport const consumer = view;\n',
    });
    linkFile(join(root, "src/renderer/src/view.ts"), join(root, "src/shared/view.ts"));

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/shared/consumer.ts:1 cannot resolve local module ./view.",
    ]);
  });

  it("applies the reviewed asset exception to real paths", () => {
    const root = fixture({
      "src/renderer/src/assets/mascot/idle.png": "png",
      "src/renderer/src/assets/icons/app.png": "png",
      "src/main/mascot-sprites.ts": [
        'import idle from "./mascot/idle.png?inline";',
        'import app from "../renderer/src/assets/mascot/icons/app.png?inline";',
        "export const sprites = [idle, app];",
        "",
      ].join("\n"),
    });
    linkDirectory(join(root, "src/renderer/src/assets/mascot"), join(root, "src/main/mascot"));
    linkDirectory(join(root, "src/renderer/src/assets/icons"), join(root, "src/renderer/src/assets/mascot/icons"));

    expect(analyzeSourceArchitecture({
      workspaceRoot: root,
      allowedAssetImports: [{ from: "src/main/mascot-sprites.ts", directory: "src/renderer/src/assets/mascot" }],
    }).failures).toEqual([
      "src/main/mascot-sprites.ts:2 crosses source layers main -> renderer via src/renderer/src/assets/icons/app.png.",
    ]);
  });
});

describe("architecture analyzer external specifiers", () => {
  it("keeps Electron and Node built-ins out of renderer and shared code", () => {
    const root = fixture({
      "src/renderer/src/electron.ts": 'import { ipcRenderer } from "electron";\nexport const value = ipcRenderer;\n',
      "src/renderer/src/renderer-subpath.ts": 'import type { IpcRenderer } from "electron/renderer";\nexport type Value = IpcRenderer;\n',
      "src/renderer/src/files.ts": 'import { readFile } from "node:fs/promises";\nexport const value = readFile;\n',
      "src/renderer/src/bare.ts": 'export const load = () => import("path");\n',
      "src/shared/hash.ts": 'import { createHash } from "crypto";\nexport const value = createHash;\n',
      "src/shared/stream.ts": 'const stream = require("fs/promises");\nexport const value = stream;\n',
      "src/shared/schema.ts": 'import { z } from "zod";\nexport const value = z;\n',
      "src/renderer/src/react.ts": 'import { useState } from "react";\nexport const value = useState;\n',
      "src/main/files.ts": 'import { app } from "electron";\nimport { readFile } from "node:fs/promises";\nexport const value = [app, readFile];\n',
      "src/preload/bridge.ts": 'import { contextBridge } from "electron";\nexport const value = contextBridge;\n',
    });

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/renderer/src/bare.ts:1 imports path into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/renderer/src/electron.ts:1 imports electron into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/renderer/src/files.ts:1 imports node:fs/promises into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/renderer/src/renderer-subpath.ts:1 imports electron/renderer into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/shared/hash.ts:1 imports crypto into the shared layer, which must not depend on Electron or Node built-ins.",
      "src/shared/stream.ts:1 imports fs/promises into the shared layer, which must not depend on Electron or Node built-ins.",
    ]);
  });

  it("rejects inline import type queries of Electron, Node built-ins and forbidden layers", () => {
    const root = fixture({
      "src/renderer/src/handle.ts": 'export type Handle = import("electron").IpcRenderer;\n',
      "src/renderer/src/view.tsx": 'export type Stats = import("node:fs").Stats;\n',
      "src/shared/buffer.ts": 'export type Bytes = import("buffer").Buffer;\n',
      "src/shared/app.ts": 'export type App = import("electron/main").App;\n',
      "src/shared/worker.ts": 'export type Worker = import("../server/worker").Worker;\n',
      "src/server/worker.ts": "export interface Worker { id: string }\n",
      "src/main/app.ts": 'export type App = import("electron").App;\n',
      "src/renderer/private-connect/vite.config.ts": 'export type Paths = import("node:path").PlatformPath;\nexport default {};\n',
    });

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/renderer/src/handle.ts:1 imports electron into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/renderer/src/view.tsx:1 imports node:fs into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/shared/app.ts:1 imports electron/main into the shared layer, which must not depend on Electron or Node built-ins.",
      "src/shared/buffer.ts:1 imports buffer into the shared layer, which must not depend on Electron or Node built-ins.",
      "src/shared/worker.ts:1 crosses source layers shared -> server via src/server/worker.ts.",
    ]);
  });

  it("exempts only the reviewed Private Connect Vite build configuration", () => {
    const root = fixture({
      "src/renderer/private-connect/vite.config.ts": 'import { resolve } from "node:path";\nexport default { root: resolve(".") };\n',
      "src/renderer/private-connect/vite.helpers.ts": 'import { resolve } from "node:path";\nexport const root = resolve(".");\n',
      "src/renderer/src/vite.config.ts": 'import { readFileSync } from "node:fs";\nexport default { read: readFileSync };\n',
      "src/shared/vite.config.mts": 'import { app } from "electron";\nexport default { app };\n',
      "src/shared/tools/vite.config.ts": 'import { readFileSync } from "fs";\nexport default { read: readFileSync };\n',
    });

    expect(analyzeSourceArchitecture({ workspaceRoot: root }).failures).toEqual([
      "src/renderer/private-connect/vite.helpers.ts:1 imports node:path into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/renderer/src/vite.config.ts:1 imports node:fs into the renderer layer, which must not depend on Electron or Node built-ins.",
      "src/shared/tools/vite.config.ts:1 imports fs into the shared layer, which must not depend on Electron or Node built-ins.",
      "src/shared/vite.config.mts:1 imports electron into the shared layer, which must not depend on Electron or Node built-ins.",
    ]);
  });
});
