import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { cursorSdkWorkerPath } from "./cursor-sdk-process";
import { nodeRuntimeFileSystem, nodeRuntimeOnPath } from "./node-runtime";
import { providerCapabilityManifest } from "./capability-manifest";
import { providerInstallationIdentity, type ProviderInstallationIdentity } from "./installation-lease";
import type { ProviderProtocolInstallationEvidence } from "./runtime-capability-attestation";

export interface CursorSdkInstallation {
  node: string;
  fingerprint: string;
  identity: ProviderInstallationIdentity;
  evidence: ProviderProtocolInstallationEvidence;
}

export function inspectCursorSdkInstallation(environment: NodeJS.ProcessEnv, credentialGeneration: string | null): CursorSdkInstallation {
  const node = nodeRuntimeOnPath(environment, { platform: process.platform, fileSystem: nodeRuntimeFileSystem,
    electronExecutable: process.versions.electron ? process.execPath : undefined });
  if (!node || !["darwin", "linux", "win32"].includes(process.platform)
    || !["arm64", "x64"].includes(process.arch) || process.platform === "win32" && process.arch !== "x64") throw new Error("Unsupported Cursor SDK platform.");
  assertCursorSdkDistributionLocation(import.meta.url);
  const require = createRequire(import.meta.url);
  const sdk = dirname(dirname(dirname(require.resolve("@cursor/sdk")))).replace(/([/\\])app\.asar([/\\])/u, "$1app.asar.unpacked$2");
  const manifest = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")) as { version?: unknown };
  if (manifest.version !== "1.0.38") throw new Error("Cursor SDK version mismatch.");
  const platform = join(dirname(sdk), `sdk-${process.platform}-${process.arch}`);
  const files: string[] = [realpathSync(node), cursorSdkWorkerPath()];
  const walk = (path: string): void => {
    if (files.length > 4096) throw new Error("Cursor SDK asset limit exceeded.");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Cursor SDK assets must be canonical.");
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
    else if (stat.isFile()) files.push(path);
    else throw new Error("Invalid Cursor SDK asset.");
  };
  walk(sdk); walk(platform);
  walk(join(dirname(cursorSdkWorkerPath()), "chunks"));
  const digest = createHash("sha256");
  for (const path of files) {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) throw new Error("Invalid Cursor SDK executable.");
    digest.update(JSON.stringify([path, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]));
  }
  const fingerprint = digest.update(credentialGeneration ?? "logged-out").digest("hex");
  const identity = providerInstallationIdentity({ providerId: "cursor", executable: realpathSync(node),
    installationRootIdentity: null, packageIdentity: "@cursor/sdk", version: "1.0.38", directFileIdentity: fingerprint,
    replacementBoundaryIdentity: "inertia-bundled-cursor-sdk", environmentIdentity: "credential-free-v1", profileIdentity: "builtin:cursor" });
  return { node: realpathSync(node), fingerprint, identity, evidence: { executable: realpathSync(node), version: "1.0.38", harnessId: "cursor-sdk",
    manifestDigest: providerCapabilityManifest("cursor-sdk")!.digest, installationFingerprint: identity.fingerprint } };
}

export function assertCursorSdkDistributionLocation(moduleUrl: string): void {
  if (/app\.asar(?:\.unpacked)?[/\\]/u.test(moduleUrl)) throw new Error("Cursor SDK packaged distribution awaits verified third-party notices.");
}
