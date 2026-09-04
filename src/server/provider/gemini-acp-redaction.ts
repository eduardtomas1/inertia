import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";
import { redactHostToolPayload } from "./host-tool-redaction";

const AUTHORIZATION_SCHEME = /^(?:basic|bearer|token)\s+(.+)$/iu;
const CREDENTIAL_ENVIRONMENT_KEY =
  /(?:^|[._-])(?:api[._-]?key|auth(?:entication|orization|[._-]key)|cookie|credentials?|(?:access|client|encryption|private|secret|service|signing|subscription)[._-]?key(?:[._-]?id)?|pass(?:code|phrase|word)?|passwd|private[._-]?key|pwd|secret|token)(?:$|[._-])/iu;
const FILE_REFERENCE_ENVIRONMENT_KEY =
  /(?:^|[._-])(?:dir(?:ectory)?|file|home|path|root|sock(?:et)?)$/iu;
// This is the parser used by dotenv 16, which Gemini CLI 0.58 calls directly.
// Keep the grammar pinned in the provider drift contract when it changes.
const DOTENV_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gmu;

const MAX_DOTENV_ANCESTORS = 128;
const MAX_DOTENV_CANDIDATES = 272;
const MAX_DOTENV_FILE_BYTES = 256 * 1024;
const MAX_DOTENV_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_DOTENV_SECRET_VALUES = 4_096;
const MAX_DOTENV_SECRET_CHARS = 1024 * 1024;

export interface GeminiDotenvInventoryOptions {
  platform?: NodeJS.Platform;
}

/**
 * Inventory credential values that Gemini CLI 0.58 may add to its own process
 * from a dotenv file after launch. We inspect every bounded candidate instead
 * of reproducing Gemini's mutable trust/settings decision, but retain only
 * credential-bearing assignments so ordinary configuration does not corrupt
 * otherwise safe assistant prose through exact-value false positives. The
 * descriptor checks attest each read, not the later pathname read performed
 * independently by Gemini after spawn.
 */
export async function geminiDotenvSecretValues(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: GeminiDotenvInventoryOptions = {},
): Promise<string[]> {
  const platform = options.platform ?? process.platform;
  // A spawned Node process reports the physical cwd. Canonicalizing here keeps
  // our ancestor search aligned when the workspace was entered through a
  // symlink rather than inspecting an alias tree Gemini will never search.
  const canonicalCwd = await realpath(cwd);
  const candidates = geminiDotenvCandidates(
    canonicalCwd,
    environment,
    platform,
  );
  const secrets: string[] = [];
  let inspectedBytes = 0;
  let secretChars = 0;

  for (const candidate of candidates) {
    const content = await readBoundedDotenv(candidate);
    if (content === null) continue;
    inspectedBytes += content.byteLength;
    if (inspectedBytes > MAX_DOTENV_TOTAL_BYTES) {
      throw new Error("Gemini dotenv candidates exceed the aggregate safety limit.");
    }
    const parsed = parseGeminiDotenv(content.toString("utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (
        !value
        || environmentOwnsKey(environment, key, platform)
      ) continue;
      const additions = credentialEnvironmentValues(key, value, true);
      for (const secret of additions) {
        if (!secret || secrets.includes(secret)) continue;
        if (
          secrets.length >= MAX_DOTENV_SECRET_VALUES
          || secret.length > MAX_DOTENV_SECRET_CHARS - secretChars
        ) {
          throw new Error("Gemini dotenv credentials exceed the redaction safety limit.");
        }
        secrets.push(secret);
        secretChars += secret.length;
      }
    }
  }
  return normalizedSecrets(secrets);
}

/**
 * Exact credential values inherited by Gemini CLI. Paths and routing selectors
 * are deliberately excluded: they are configuration, not bearer credentials.
 */
export function geminiEnvironmentSecretValues(
  environment: NodeJS.ProcessEnv,
): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (!value) continue;
    secrets.push(...credentialEnvironmentValues(key, value, false));
  }
  return normalizedSecrets(secrets);
}

/**
 * Owns exact-value redaction for one Gemini ACP run. Structured payloads are
 * replaced immediately. Assistant and reasoning streams retain only a bounded
 * suffix that could still become a credential when the next chunk arrives.
 */
export class GeminiAcpSecretRedactor {
  private readonly secrets: string[];
  private readonly assistant: BoundarySecretRedactor;
  private readonly reasoning: BoundarySecretRedactor;
  private readonly stderr: BoundarySecretRedactor;
  private streamsStarted = false;

  constructor(environment: NodeJS.ProcessEnv) {
    this.secrets = geminiEnvironmentSecretValues(environment);
    this.assistant = new BoundarySecretRedactor(() => this.secrets);
    this.reasoning = new BoundarySecretRedactor(() => this.secrets);
    this.stderr = new BoundarySecretRedactor(() => this.secrets);
  }

  addSecrets(values: readonly string[]): void {
    if (this.streamsStarted) {
      throw new Error("Gemini ACP credentials changed after output streaming began.");
    }
    const merged = normalizedSecrets([...this.secrets, ...values]);
    this.secrets.splice(0, this.secrets.length, ...merged);
    this.assistant.invalidate();
    this.reasoning.invalidate();
    this.stderr.invalidate();
  }

  payload<T>(value: T): T {
    return redactHostToolPayload(value, this.secrets);
  }

  assistantChunk(value: string): string {
    this.streamsStarted = true;
    return this.assistant.push(value);
  }

  reasoningChunk(value: string): string {
    this.streamsStarted = true;
    return this.reasoning.push(value);
  }

  stderrChunk(value: string): string {
    return this.stderr.push(value);
  }

  finishStderr(): string {
    // A diagnostic stream can end or be capped in the middle of a credential.
    // Never release a suffix that is a prefix of a known secret.
    return this.stderr.finish(true);
  }

  finishAssistant(): string {
    return this.assistant.finish();
  }

  finishReasoning(): string {
    return this.reasoning.finish();
  }

  discardStreams(): void {
    this.assistant.discard();
    this.reasoning.discard();
  }
}

function normalizedSecrets(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
}

function geminiDotenvCandidates(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const roots: string[] = [];
  let current = resolve(cwd);
  for (let depth = 0; depth < MAX_DOTENV_ANCESTORS; depth += 1) {
    roots.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    if (depth === MAX_DOTENV_ANCESTORS - 1) {
      throw new Error("Gemini dotenv ancestor search exceeds the safety limit.");
    }
  }

  const configuredHome = environmentValue(
    environment,
    "GEMINI_CLI_HOME",
    platform,
  );
  const environmentHomes = platform === "win32"
    ? [
        environmentValue(environment, "USERPROFILE", platform),
        environmentValue(environment, "HOME", platform),
        windowsHomeDrivePath(environment, platform),
      ]
    : [environmentValue(environment, "HOME", platform)];
  for (const home of [configuredHome, ...environmentHomes, homedir()]) {
    if (!home || home.includes("\0")) continue;
    roots.push(isAbsolute(home) ? resolve(home) : resolve(cwd, home));
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const candidate of [
      join(root, ".gemini", ".env"),
      join(root, ".env"),
    ]) {
      const identity = platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push(candidate);
      if (candidates.length > MAX_DOTENV_CANDIDATES) {
        throw new Error("Gemini dotenv candidate search exceeds the safety limit.");
      }
    }
  }
  return candidates;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  wantedKey: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[wantedKey];
  const normalized = wantedKey.toUpperCase();
  return Object.entries(environment)
    .filter(([key, value]) => key.toUpperCase() === normalized && value !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)[0]?.[1];
}

function environmentOwnsKey(
  environment: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "win32") {
    return Object.hasOwn(environment, key) && environment[key] !== undefined;
  }
  const normalized = key.toUpperCase();
  return Object.entries(environment).some(
    ([candidate, value]) => candidate.toUpperCase() === normalized && value !== undefined,
  );
}

function windowsHomeDrivePath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const drive = environmentValue(environment, "HOMEDRIVE", platform);
  const path = environmentValue(environment, "HOMEPATH", platform);
  return drive && path ? `${drive}${path}` : undefined;
}

async function readBoundedDotenv(path: string): Promise<Buffer | null> {
  const before = await lstat(path, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("Gemini dotenv inventory found an unsafe candidate.");
  }
  const noFollow = "O_NOFOLLOW" in fsConstants ? FILE_OPEN_NO_FOLLOW : 0;
  const nonBlocking = "O_NONBLOCK" in fsConstants ? fsConstants.O_NONBLOCK : 0;
  const handle = await open(
    path,
    fsConstants.O_RDONLY | noFollow | nonBlocking,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || !sameFileIdentity(before, opened)
      || opened.size > BigInt(MAX_DOTENV_FILE_BYTES)
    ) {
      throw new Error("Gemini dotenv inventory found an unsafe candidate.");
    }
    const content = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new Error("Gemini dotenv candidate changed while it was inspected.");
      }
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await handle.read(
      trailing,
      0,
      1,
      content.byteLength,
    );
    const after = await handle.stat({ bigint: true });
    if (
      trailingBytes !== 0
      || !sameFileSnapshot(opened, after)
    ) {
      throw new Error("Gemini dotenv candidate changed while it was inspected.");
    }
    return content;
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function parseGeminiDotenv(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const normalized = content.replace(/\r\n?/gu, "\n");
  DOTENV_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DOTENV_LINE.exec(normalized)) !== null) {
    const key = match[1]!;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gmu, "$2");
    if (quote === '"') {
      value = value.replace(/\\n/gu, "\n").replace(/\\r/gu, "\r");
    }
    parsed[key] = value;
  }
  return parsed;
}

function credentialEnvironmentValues(
  key: string,
  value: string,
  includeUntrustedVariant: boolean,
): string[] {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey === "GEMINI_CLI_CUSTOM_HEADERS") {
    return customHeaderSecretValues(value);
  }
  if (
    normalizedKey === "GEMINI_API_KEY_AUTH_MECHANISM"
    || normalizedKey === "GOOGLE_APPLICATION_CREDENTIALS"
    || normalizedKey === "OLDPWD"
    || normalizedKey === "PWD"
    || !CREDENTIAL_ENVIRONMENT_KEY.test(key)
    || FILE_REFERENCE_ENVIRONMENT_KEY.test(key)
  ) return [];
  // Gemini sanitizes the four values it permits from an untrusted project
  // dotenv file. Retain both representations because the same candidate can
  // be trusted or untrusted and the trust decision belongs to Gemini.
  const untrustedValue = includeUntrustedVariant
    ? value.replace(/[^a-zA-Z0-9\-_./]/gu, "")
    : value;
  return untrustedValue && untrustedValue !== value
    ? [value, untrustedValue]
    : [value];
}

function customHeaderSecretValues(customHeaders: string): string[] {
  // The complete environment value can itself appear in diagnostics.
  const secrets = [customHeaders];
  for (const entry of customHeaders.split(/,(?=\s*[^,:]+:)/u)) {
    const separator = entry.indexOf(":");
    if (separator < 0) continue;
    const value = entry.slice(separator + 1).trim();
    if (!value) continue;
    // Gemini accepts arbitrary gateway headers, so names cannot classify
    // whether a value is a credential. Treat every custom-header value as
    // secret rather than allowing an innocuous-looking name to bypass the
    // exact-value redactor.
    secrets.push(value);
    const credential = AUTHORIZATION_SCHEME.exec(value)?.[1];
    if (credential) secrets.push(credential);
  }
  return secrets;
}

class BoundarySecretRedactor {
  private pending = "";
  private finished = false;
  private root: SecretTrieNode | undefined;

  constructor(private readonly secrets: () => readonly string[]) {}

  push(value: string): string {
    if (this.finished || !value) return "";
    this.pending += value;
    return this.drain(false);
  }

  finish(redactPartial = false): string {
    if (this.finished) return "";
    this.finished = true;
    return this.drain(true, redactPartial);
  }

  discard(): void {
    this.pending = "";
    this.finished = true;
  }

  invalidate(): void {
    this.root = undefined;
  }

  private drain(final: boolean, redactPartial = false): string {
    const root = this.root ??= secretTrie(this.secrets());
    if (root.children.size === 0) {
      const output = this.pending;
      this.pending = "";
      return output;
    }
    let cursor = 0;
    let output = "";
    while (cursor < this.pending.length) {
      let node = root;
      let scan = cursor;
      let lastTerminal = -1;
      while (scan < this.pending.length) {
        const next = node.children.get(this.pending[scan]!);
        if (!next) break;
        node = next;
        scan += 1;
        if (node.terminal) lastTerminal = scan;
      }
      if (scan < this.pending.length) {
        if (lastTerminal >= 0) {
          output += "[redacted]";
          cursor = lastTerminal;
        } else {
          output += this.pending[cursor]!;
          cursor += 1;
        }
        continue;
      }
      if (node.terminal && (final || node.children.size === 0)) {
        output += "[redacted]";
        cursor = scan;
        continue;
      }
      if (!final) break;
      if (lastTerminal >= 0) {
        output += "[redacted]";
        cursor = lastTerminal;
      } else if (redactPartial && scan > cursor) {
        output += "[redacted]";
        cursor = scan;
      } else {
        output += this.pending[cursor]!;
        cursor += 1;
      }
    }
    this.pending = this.pending.slice(cursor);
    return output;
  }
}

interface SecretTrieNode {
  readonly children: Map<string, SecretTrieNode>;
  terminal: boolean;
}

function secretTrie(secrets: readonly string[]): SecretTrieNode {
  const root: SecretTrieNode = { children: new Map(), terminal: false };
  for (const secret of secrets) {
    let node = root;
    for (let index = 0; index < secret.length; index += 1) {
      const unit = secret[index]!;
      let child = node.children.get(unit);
      if (!child) {
        child = { children: new Map(), terminal: false };
        node.children.set(unit, child);
      }
      node = child;
    }
    node.terminal = true;
  }
  return root;
}
