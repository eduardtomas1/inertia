import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function loadCursorSdk() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@cursor/sdk");
  const manifest = JSON.parse(readFileSync(resolve(dirname(entry), "../../package.json"), "utf8")) as { version?: unknown };
  if (manifest.version !== "1.0.38") throw new Error("The bundled Cursor SDK version is unsupported.");
  return require("@cursor/sdk") as typeof import("@cursor/sdk");
}

export function loadCursorSdkSqlite() {
  const require = createRequire(import.meta.url);
  return require("@cursor/sdk/sqlite") as typeof import("@cursor/sdk/sqlite");
}

export function verifyCursorSdkPlatform(): void {
  const require = createRequire(import.meta.url);
  const verifyVersion = (manifest: { version?: unknown }) => {
    if (manifest.version !== "1.0.38") throw new Error("Cursor SDK platform version mismatch.");
  };
  switch (`${process.platform}-${process.arch}`) {
    case "darwin-arm64":
      verifyVersion(require("@cursor/sdk-darwin-arm64/package.json") as { version?: unknown });
      require("@cursor/sdk-darwin-arm64/vendor/tree-sitter/index.js");
      require("@cursor/sdk-darwin-arm64/vendor/tree-sitter-bash/index.js");
      return;
    case "darwin-x64":
      verifyVersion(require("@cursor/sdk-darwin-x64/package.json") as { version?: unknown });
      require("@cursor/sdk-darwin-x64/vendor/tree-sitter/index.js");
      require("@cursor/sdk-darwin-x64/vendor/tree-sitter-bash/index.js");
      return;
    case "linux-arm64":
      verifyVersion(require("@cursor/sdk-linux-arm64/package.json") as { version?: unknown });
      require("@cursor/sdk-linux-arm64/vendor/tree-sitter/index.js");
      require("@cursor/sdk-linux-arm64/vendor/tree-sitter-bash/index.js");
      return;
    case "linux-x64":
      verifyVersion(require("@cursor/sdk-linux-x64/package.json") as { version?: unknown });
      require("@cursor/sdk-linux-x64/vendor/tree-sitter/index.js");
      require("@cursor/sdk-linux-x64/vendor/tree-sitter-bash/index.js");
      return;
    case "win32-x64":
      verifyVersion(require("@cursor/sdk-win32-x64/package.json") as { version?: unknown });
      require("@cursor/sdk-win32-x64/vendor/tree-sitter/index.js");
      require("@cursor/sdk-win32-x64/vendor/tree-sitter-bash/index.js");
      return;
    default:
      throw new Error("Cursor SDK platform is unsupported.");
  }
}
