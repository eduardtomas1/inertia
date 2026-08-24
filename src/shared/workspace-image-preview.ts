import type { OpenProjectPathRequest } from "./desktop";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_IMAGE_PATH = /^\/workspace-image\/([^/]+)\/([^/]+)\/([^/]+)$/u;

export const MAX_WORKSPACE_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;

export function applicationRendererScheme(protocol?: string): "inertia" | "inertia-canary" {
  return protocol === "inertia-canary:" ? "inertia-canary" : "inertia";
}

export function applicationProductName(protocol?: string): "Inertia" | "Inertia Canary" {
  return protocol === "inertia-canary:" ? "Inertia Canary" : "Inertia";
}

export function workspaceImagePreviewUrl(request: {
  projectId: string;
  conversationId?: string;
  relativePath: string;
}, scheme: "inertia" | "inertia-canary" = "inertia"): string {
  const owner = request.conversationId ?? "project";
  return `${scheme}://bundle/workspace-image/${encodeURIComponent(request.projectId)}/${encodeURIComponent(owner)}/${encodeURIComponent(request.relativePath)}`;
}

export function parseWorkspaceImagePreviewUrl(
  value: URL,
): OpenProjectPathRequest | null {
  const match = WORKSPACE_IMAGE_PATH.exec(value.pathname);
  if (!match) return null;
  let projectId: string;
  let owner: string;
  let relativePath: string;
  try {
    projectId = decodeURIComponent(match[1]!);
    owner = decodeURIComponent(match[2]!);
    relativePath = decodeURIComponent(match[3]!);
  } catch {
    return null;
  }
  if (
    !UUID_PATTERN.test(projectId)
    || (owner !== "project" && !UUID_PATTERN.test(owner))
    || relativePath.length === 0
    || relativePath.length > 4_096
    || /[\0\r\n]/u.test(relativePath)
    || /^[\\/]/u.test(relativePath)
    || /^[A-Za-z]:/u.test(relativePath)
    || relativePath.split(/[\\/]/u).some((segment) => segment === "..")
  ) return null;
  return {
    projectId,
    ...(owner === "project" ? {} : { conversationId: owner }),
    relativePath,
    action: "open-externally",
  };
}
