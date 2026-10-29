import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { isSecretRequestFileName } from "../../../shared/agent-secrets";

export const AGENT_SECRETS_DIRECTORY = "agent-secrets";

const FILE_TOKEN = /^[0-9a-f]{32}$/u;

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
