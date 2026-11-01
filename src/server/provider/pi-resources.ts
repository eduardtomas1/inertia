import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { credentialFreeProviderEnvironment } from "../environment";
import type { AgentHarnessStartOptions } from "./agent-harness";
import { isOwnAttachmentPath } from "./attachment-read-grant";
import { PI_BRIDGE_SOURCE } from "./pi-bridge-source";
import type { ProviderHostToolMcpConnection } from "./host-tool-mcp-http";
import { imageMediaType, MAX_PROVIDER_REQUEST_IMAGE_COUNT, readBoundedProviderImage } from "./provider-image-read";

export async function stagePiBridge(options: AgentHarnessStartOptions, host?: ProviderHostToolMcpConnection) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "inertia-pi-"));
  const file = join(directory, "bridge.mjs");
  const nonce = randomUUID();
  try { await writeFile(file, PI_BRIDGE_SOURCE, { mode: 0o600, flag: "wx" }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    file, nonce,
    environment: {
      ...options.environment,
      INERTIA_PI_READY: nonce, INERTIA_PI_ACCESS: options.input.interactionMode === "plan" || options.input.readOnlyProfile ? "read-only" : options.input.access,
      INERTIA_PI_NATIVE_TOOLS: options.providerNativeToolsAvailable ? "1" : "0",
      INERTIA_PI_TOOL_ENV: JSON.stringify(credentialFreeProviderEnvironment(options.environment)),
      INERTIA_PI_INSTRUCTIONS: [options.input.systemInstruction, options.input.sessionInstruction,
        options.input.interactionMode === "plan" ? "Prepare a plan. Do not modify files or run mutating commands." : "",
        ...(options.input.skills ?? []).map((skill) => `The user selected Pi skill ${JSON.stringify(skill.name)}. Read and follow ${JSON.stringify(skill.path)}.`),
      ].filter(Boolean).join("\n\n"),
      ...(host ? { INERTIA_PI_MCP_URL: host.url, INERTIA_PI_MCP_TOKEN: host.bearerToken } : {}),
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

export async function piImages(paths: readonly string[], roots: readonly string[] | undefined, signal?: AbortSignal) {
  if (paths.length > MAX_PROVIDER_REQUEST_IMAGE_COUNT) throw new Error("Too many Pi image attachments.");
  let bytes = 0;
  const images: Array<{ type: "image"; mimeType: string; data: string }> = [];
  for (const path of paths) {
    const mimeType = imageMediaType(path);
    if (!mimeType || !isOwnAttachmentPath(path, roots)) throw new Error("Pi image is outside the authorized attachment roots.");
    const image = await readBoundedProviderImage("Pi", path, bytes, signal);
    bytes += image.length;
    images.push({ type: "image", mimeType, data: image.toString("base64") });
  }
  return images;
}
