import type {
  GitForge,
  GitPullRequestCapability,
  GitPullRequestUnavailableReason,
} from "../../shared/contracts";
import { MAX_PATH_LENGTH } from "./constants";
import { runGitInspection } from "./runner";

const MAX_REMOTE_OUTPUT_BYTES = 256 * 1024;

interface ConfiguredRemote {
  name: string;
  pushUrls: string[];
}

export interface GitRemoteWebTarget {
  forge: GitForge;
  baseUrl: string;
}

export interface GitPullRequestTarget extends GitRemoteWebTarget {
  remoteName: string;
}

export interface GitRemoteRoutingInspection {
  hasRemote: boolean;
  selectedRemoteName: string | null;
  pullRequest: GitPullRequestCapability;
  target: GitPullRequestTarget | null;
}

function forgeForHost(hostname: string): GitForge | null {
  const host = hostname.toLowerCase();
  if (host === "github.com") {
    return "github";
  }
  if (host === "gitlab.com") {
    return "gitlab";
  }
  if (host === "bitbucket.org") {
    return "bitbucket";
  }
  return null;
}

function remoteWebBase(remoteUrl: string): URL | null {
  const trimmed = remoteUrl.trim();
  if (
    trimmed.length === 0
    || trimmed.length > MAX_PATH_LENGTH
    || trimmed.includes("\0")
    || trimmed.includes("\r")
    || trimmed.includes("\n")
  ) {
    return null;
  }

  const scp = /^[^@/:\\\s]+@([^/:\\\s]+):(.+)$/u.exec(trimmed);
  const candidate = scp ? `ssh://${scp[1]}/${scp[2]}` : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol === "ssh:") {
    const sshUrl = url;
    url = new URL("https://git.invalid");
    url.hostname = sshUrl.hostname;
    url.pathname = sshUrl.pathname;
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") return null;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.git\/?$/u, "").replace(/\/+$/u, "");
  return url.pathname === "" || url.pathname === "/" ? null : url;
}

/** Pure, credential-stripping parser used by remote routing and portability tests. */
export function parseGitRemoteWebTarget(
  remoteUrl: string,
): GitRemoteWebTarget | null {
  const base = remoteWebBase(remoteUrl);
  if (!base) return null;
  const forge = forgeForHost(base.hostname);
  if (!forge) return null;
  return {
    forge,
    baseUrl: base.toString().replace(/\/$/u, ""),
  };
}

function configuredRemotes(buffer: Buffer): Map<string, ConfiguredRemote> {
  const remotes = new Map<string, ConfiguredRemote>();
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    const remote = remotes.get(name) ?? { name, pushUrls: [] };
    remotes.set(name, remote);
    const match = /^(.*) \((fetch|push)\)$/u.exec(line.slice(separator + 1));
    if (match?.[2] === "push" && match[1]) {
      remote.pushUrls.push(match[1]);
    }
  }
  return remotes;
}

function branchRouting(buffer: Buffer): {
  trackedRemoteName: string | null;
  pushRemoteName: string | null;
} {
  const [trackedRemoteName = "", pushRemoteName = ""] = buffer
    .toString("utf8")
    .trimEnd()
    .split("\0");
  return {
    trackedRemoteName: trackedRemoteName || null,
    pushRemoteName: pushRemoteName || null,
  };
}

function unavailable(
  hasRemote: boolean,
  reason: GitPullRequestUnavailableReason,
  remoteName: string | null = null,
): GitRemoteRoutingInspection {
  return {
    hasRemote,
    selectedRemoteName: remoteName,
    pullRequest: {
      available: false,
      remoteName,
      forge: null,
      unavailableReason: reason,
    },
    target: null,
  };
}

export async function inspectGitRemoteRouting(
  root: string,
  branch: string | null,
  options: { deadlineAt?: number } = {},
): Promise<GitRemoteRoutingInspection> {
  const [remoteResult, branchResult] = await Promise.all([
    runGitInspection(root, ["remote", "-v"], {
      deadlineAt: options.deadlineAt,
      maxOutputBytes: MAX_REMOTE_OUTPUT_BYTES,
      failureMessage: "Unable to inspect repository remotes.",
    }),
    branch
      ? runGitInspection(
          root,
          [
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(push:remotename)",
            `refs/heads/${branch}`,
          ],
          {
            deadlineAt: options.deadlineAt,
            maxOutputBytes: MAX_PATH_LENGTH,
            failureMessage: "Unable to inspect branch remote configuration.",
          },
        )
      : Promise.resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          truncated: false,
        }),
  ]);
  const remotes = configuredRemotes(remoteResult.stdout);
  const hasRemote = remotes.size > 0;
  if (!branch) return unavailable(hasRemote, "no-branch");
  if (!hasRemote) return unavailable(false, "no-remotes");

  const routing = branchRouting(branchResult.stdout);
  const selectedRemoteName = routing.pushRemoteName
    ?? routing.trackedRemoteName
    ?? (remotes.has("origin") ? "origin" : null)
    ?? (remotes.size === 1 ? remotes.keys().next().value ?? null : null);
  if (!selectedRemoteName) return unavailable(true, "ambiguous-remote");
  const selected = remotes.get(selectedRemoteName);
  if (!selected) return unavailable(true, "missing-remote", selectedRemoteName);
  if (selected.pushUrls.length === 0) {
    return unavailable(true, "unsupported-url", selectedRemoteName);
  }

  const bases = new Map<string, GitRemoteWebTarget>();
  let hasWebUrl = false;
  for (const pushUrl of selected.pushUrls) {
    const webBase = remoteWebBase(pushUrl);
    if (webBase) hasWebUrl = true;
    const target = parseGitRemoteWebTarget(pushUrl);
    if (target) bases.set(target.baseUrl, target);
  }
  if (bases.size === 0) {
    return unavailable(
      true,
      hasWebUrl ? "unsupported-forge" : "unsupported-url",
      selectedRemoteName,
    );
  }
  if (bases.size !== 1 || bases.size !== new Set(selected.pushUrls.map((url) => {
    const base = remoteWebBase(url);
    return base?.toString().replace(/\/$/u, "") ?? url;
  })).size) {
    return unavailable(true, "ambiguous-url", selectedRemoteName);
  }
  const target = bases.values().next().value;
  if (!target) return unavailable(true, "unsupported-url", selectedRemoteName);
  return {
    hasRemote: true,
    selectedRemoteName,
    pullRequest: {
      available: true,
      remoteName: selectedRemoteName,
      forge: target.forge,
      unavailableReason: null,
    },
    target: { ...target, remoteName: selectedRemoteName },
  };
}
