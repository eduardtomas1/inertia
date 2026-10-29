import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, type Stats } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from "../../../node/platform-file-open-flags";
import { AGENT_SECRET_MAX_LENGTH } from "../../../shared/agent-secrets";
import { isAgentSecretValue, isSecretRequestFileName } from "../../../node/agent-secrets";

export const AGENT_SECRETS_DIRECTORY = "agent-secrets";

const FILE_TOKEN = /^[0-9a-f]{32}$/u;
const PARTIAL_SUFFIX = ".partial";
const MAX_RETAINED_TOKENS = 128;
const MAX_RETAINED_FILES_PER_TOKEN = 4;
const MAX_RETAINED_FILE_BYTES = AGENT_SECRET_MAX_LENGTH * 4;

export function agentSecretRoot(dataDirectory: string): string {
  return join(dataDirectory, AGENT_SECRETS_DIRECTORY);
}

export function newAgentSecretFileToken(): string {
  return randomBytes(16).toString("hex");
}

export function isAgentSecretFileToken(value: unknown): value is string {
  return typeof value === "string" && FILE_TOKEN.test(value);
}

export function agentSecretFilePath(root: string, token: string, fileName: string): string {
  if (!isAgentSecretFileToken(token) || !isSecretRequestFileName(fileName)) {
    throw new Error("Invalid agent secret file location.");
  }
  return join(root, token, fileName);
}

export function ensureAgentSecretRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => null);
  try {
    await handle?.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAgentSecretFile(
  root: string,
  token: string,
  fileName: string,
  value: string,
): Promise<string> {
  const target = agentSecretFilePath(root, token, fileName);
  const directory = join(root, token);
  ensureAgentSecretRoot(root);
  await rm(directory, { recursive: true, force: true });
  try {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
    const partial = `${target}.partial`;
    const handle = await open(partial, "wx", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, target);
    await chmod(target, 0o600);
    await syncDirectory(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return target;
}

export function removeAgentSecretDirectory(root: string, token: string): void {
  if (!isAgentSecretFileToken(token)) return;
  rmSync(join(root, token), { recursive: true, force: true });
}

export function clearAgentSecretRoot(root: string, keep: ReadonlySet<string> = new Set()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    try {
      rmSync(join(root, entry), { recursive: true, force: true });
    } catch {
    }
  }
}

export function retainedAgentSecretTokens(root: string): string[] {
  try {
    return readdirSync(root).filter(isAgentSecretFileToken).slice(0, MAX_RETAINED_TOKENS);
  } catch {
    return [];
  }
}

function privatelyOwned(stats: Stats, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true;
  return stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0;
}

function retainedFileName(name: string): boolean {
  const base = name.endsWith(PARTIAL_SUFFIX) ? name.slice(0, -PARTIAL_SUFFIX.length) : name;
  return isSecretRequestFileName(base);
}

function readRetainedFile(path: string, platform: NodeJS.Platform): string | null {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_RETAINED_FILE_BYTES || !privatelyOwned(before, platform)) {
    return null;
  }
  const descriptor = openSync(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_RETAINED_FILE_BYTES) {
      return null;
    }
    const buffer = Buffer.alloc(opened.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(descriptor, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    const value = buffer.subarray(0, read).toString("utf8");
    return isAgentSecretValue(value) ? value : null;
  } finally {
    closeSync(descriptor);
  }
}

export function readRetainedAgentSecretValues(
  root: string,
  token: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!isAgentSecretFileToken(token)) return [];
  try {
    const rootStats = lstatSync(root);
    const directory = join(root, token);
    const directoryStats = lstatSync(directory);
    if (!rootStats.isDirectory() || !directoryStats.isDirectory() || !privatelyOwned(directoryStats, platform)) return [];
    const values = new Set<string>();
    for (const name of readdirSync(directory).filter(retainedFileName).slice(0, MAX_RETAINED_FILES_PER_TOKEN)) {
      try {
        const value = readRetainedFile(join(directory, name), platform);
        if (value !== null) values.add(value);
      } catch {
      }
    }
    return [...values];
  } catch {
    return [];
  }
}
