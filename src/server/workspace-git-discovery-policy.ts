import { opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export const WORKSPACE_GIT_DISCOVERY_BOUNDS = Object.freeze({
  maxDepth: 4,
  containerDepth: 2,
  maxDirectories: 256,
  maxEntries: 4_096,
  maxRepositories: 32,
  statusConcurrency: 4,
  maxIssues: 20,
  traversalMs: 2_000,
  statusAdmissionMs: 5_000,
  repositoryStatusMs: 10_000,
});

/** Broad system/user roots are never automatic repository search scopes. */
export function isBroadWorkspaceRoot(
  directory: string,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const paths = platform === "win32" ? win32 : posix;
  const normalize = (value: string): string => {
    const normalized = paths.resolve(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const root = normalize(directory);
  const userHome = normalize(home);
  // This also covers /home, /Users, drive roots and UNC share roots.
  const homeRelative = paths.relative(root, userHome);
  return root === paths.parse(root).root
    || homeRelative === ""
    || homeRelative !== ".."
      && !homeRelative.startsWith(`..${paths.sep}`)
      && !paths.isAbsolute(homeRelative);
}

let canonicalHome: { path: string; result: Promise<string> } | undefined;

async function resolveHome(home: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      realpath(home).catch(() => home),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(home), WORKSPACE_GIT_DISCOVERY_BOUNDS.traversalMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function isBroadWorkspaceDirectory(directory: string): Promise<boolean> {
  const home = homedir();
  if (isBroadWorkspaceRoot(directory, home)) return true;
  // Resolve aliases such as /var -> /private/var or a symlinked HOME once,
  // never once per traversed folder. A slow/unavailable home retains the
  // lexical guard and the independent traversal/status limits.
  if (canonicalHome?.path !== home) canonicalHome = { path: home, result: resolveHome(home) };
  return isBroadWorkspaceRoot(directory, await canonicalHome.result);
}

/** Stream a bounded prefix: readdir would first allocate the entire folder. */
export async function readDiscoveryEntries(
  directory: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ entries: import("node:fs").Dirent[]; truncated: boolean }> {
  const entries: import("node:fs").Dirent[] = [];
  signal?.throwIfAborted();
  const handle = await opendir(directory, { bufferSize: Math.min(32, limit) });
  if (signal?.aborted) {
    await handle.close();
    signal.throwIfAborted();
  }
  // The iterator closes its handle on return/throw, including a late result
  // after the caller's filesystem deadline has already aborted.
  for await (const entry of handle) {
    signal?.throwIfAborted();
    if (entries.length === limit) return { entries, truncated: true };
    entries.push(entry);
  }
  return { entries, truncated: false };
}
