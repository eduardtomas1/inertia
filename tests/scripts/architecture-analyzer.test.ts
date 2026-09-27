import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
