import { redactHostToolPayload } from "./host-tool-redaction";

const CREDENTIAL_ENVIRONMENT_KEY =
  /(?:^|[._-])(?:api[._-]?key|auth(?:entication|orization|[._-]key)|cookie|credentials?|(?:access|client|encryption|private|secret|service|signing|subscription)[._-]?key(?:[._-]?id)?|pass(?:code|phrase|word)?|passwd|private[._-]?key|pwd|secret|token)(?:$|[._-])/iu;
const SIGNIFICANT_SECRET_PREFIX_CHARS = 6;
const FILE_REFERENCE_ENVIRONMENT_KEY =
  /(?:^|[._-])(?:dir(?:ectory)?|file|home|path|root|sock(?:et)?)$/iu;

export function acpEnvironmentSecretValues(
  environment: NodeJS.ProcessEnv,
): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (!value || !isCredentialEnvironmentKey(key)) continue;
    secrets.push(value);
  }
  return normalizedSecrets(secrets);
}

export class AcpSecretRedactor {
  private readonly secrets: string[];
  private readonly assistant: BoundarySecretRedactor;
  private readonly reasoning: BoundarySecretRedactor;
  private readonly stderr: BoundarySecretRedactor;

  constructor(environment: NodeJS.ProcessEnv) {
    this.secrets = acpEnvironmentSecretValues(environment);
    this.assistant = new BoundarySecretRedactor(() => this.secrets);
    this.reasoning = new BoundarySecretRedactor(() => this.secrets);
    this.stderr = new BoundarySecretRedactor(() => this.secrets);
  }

  addSecrets(values: readonly string[]): void {
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
    return this.assistant.push(value);
  }

  reasoningChunk(value: string): string {
    return this.reasoning.push(value);
  }

  stderrChunk(value: string): string {
    return this.stderr.push(value);
  }

  finishStderr(): string {
    return this.stderr.finish("all");
  }

  finishAssistant(): string {
    return this.assistant.finish("significant");
  }

  finishReasoning(): string {
    return this.reasoning.finish("significant");
  }

  discardStreams(): void {
    this.assistant.discard();
    this.reasoning.discard();
  }
}

function isCredentialEnvironmentKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return normalizedKey !== "GOOGLE_APPLICATION_CREDENTIALS"
    && normalizedKey !== "AGENT_CLI_CREDENTIAL_STORE"
    && normalizedKey !== "OLDPWD"
    && normalizedKey !== "PWD"
    && CREDENTIAL_ENVIRONMENT_KEY.test(key)
    && !FILE_REFERENCE_ENVIRONMENT_KEY.test(key);
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

  finish(redactPartial: PartialSecretRedaction): string {
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

  private drain(final: boolean, redactPartial?: PartialSecretRedaction): string {
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
      } else if (scan > cursor && redactsPartialSecret(redactPartial, scan - cursor, node)) {
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

type PartialSecretRedaction = "all" | "significant";

interface SecretTrieNode {
  readonly children: Map<string, SecretTrieNode>;
  terminal: boolean;
  shortestSecret: number;
}

function redactsPartialSecret(
  policy: PartialSecretRedaction | undefined,
  length: number,
  node: SecretTrieNode,
): boolean {
  return policy === "all"
    || (policy === "significant"
      && (length >= SIGNIFICANT_SECRET_PREFIX_CHARS || length * 2 >= node.shortestSecret));
}

function secretTrie(secrets: readonly string[]): SecretTrieNode {
  const root: SecretTrieNode = { children: new Map(), terminal: false, shortestSecret: Infinity };
  for (const secret of secrets) {
    let node = root;
    for (let index = 0; index < secret.length; index += 1) {
      const unit = secret[index]!;
      let child = node.children.get(unit);
      if (!child) {
        child = { children: new Map(), terminal: false, shortestSecret: secret.length };
        node.children.set(unit, child);
      }
      child.shortestSecret = Math.min(child.shortestSecret, secret.length);
      node = child;
    }
    node.terminal = true;
  }
  return root;
}
