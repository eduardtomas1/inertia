import { redactHostToolPayload } from "./host-tool-redaction";

const GEMINI_SECRET_ENVIRONMENT_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
] as const;

const SENSITIVE_CUSTOM_HEADER_NAME =
  /(?:^|[-_])(?:api[-_]?key|auth(?:entication|orization)?|cookie|credential|secret|token)(?:$|[-_])/iu;
const AUTHORIZATION_SCHEME = /^(?:basic|bearer|token)\s+(.+)$/iu;

/**
 * Exact credential values inherited by Gemini CLI. Paths and routing selectors
 * are deliberately excluded: they are configuration, not bearer credentials.
 */
export function geminiEnvironmentSecretValues(
  environment: NodeJS.ProcessEnv,
): string[] {
  const secrets = GEMINI_SECRET_ENVIRONMENT_KEYS.flatMap((key) =>
    environmentValues(environment, key));
  for (const customHeaders of environmentValues(
    environment,
    "GEMINI_CLI_CUSTOM_HEADERS",
  )) {
    // The complete environment value can itself appear in diagnostics.
    secrets.push(customHeaders);
    for (const entry of customHeaders.split(/,(?=\s*[^,:]+:)/u)) {
      const separator = entry.indexOf(":");
      if (separator < 0) continue;
      const name = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (!value || !SENSITIVE_CUSTOM_HEADER_NAME.test(name)) continue;
      secrets.push(value);
      const credential = AUTHORIZATION_SCHEME.exec(value)?.[1];
      if (credential) secrets.push(credential);
    }
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
  private streamsStarted = false;

  constructor(environment: NodeJS.ProcessEnv) {
    this.secrets = geminiEnvironmentSecretValues(environment);
    this.assistant = new BoundarySecretRedactor(() => this.secrets);
    this.reasoning = new BoundarySecretRedactor(() => this.secrets);
  }

  addSecrets(values: readonly string[]): void {
    if (this.streamsStarted) {
      throw new Error("Gemini ACP credentials changed after output streaming began.");
    }
    const merged = normalizedSecrets([...this.secrets, ...values]);
    this.secrets.splice(0, this.secrets.length, ...merged);
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

function environmentValues(
  environment: NodeJS.ProcessEnv,
  wantedKey: string,
): string[] {
  return Object.entries(environment).flatMap(([key, value]) =>
    key.toUpperCase() === wantedKey && value ? [value] : []);
}

function normalizedSecrets(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
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

  finish(): string {
    if (this.finished) return "";
    this.finished = true;
    return this.drain(true);
  }

  discard(): void {
    this.pending = "";
    this.finished = true;
  }

  private drain(final: boolean): string {
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
