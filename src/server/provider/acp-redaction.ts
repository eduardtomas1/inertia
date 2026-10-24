import type { SessionNotification } from "@agentclientprotocol/sdk";
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

  /** Stream text must reach assistantChunk/reasoningChunk before masking. */
  streamNotification(notification: SessionNotification): SessionNotification {
    const update = notification.update;
    if ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")
      && update.content.type === "text") {
      // Masking a shorter credential inside one delta can destroy the match
      // for a longer credential spanning deltas. Keep only this validated text
      // for the boundary redactor; redact all surrounding metadata as usual.
      const { text, ...metadata } = update.content;
      const safe = this.payload({
        ...notification, update: { ...update, content: { ...metadata, text: "" } },
      });
      return { ...safe, update: { ...safe.update, content: { ...safe.update.content, text } } };
    }
    return this.payload(notification);
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
    const text = this.pending;
    if (root.children.size === 0) {
      this.pending = "";
      return text;
    }
    const runs: SecretRun[] = [];
    let held = text.length;
    for (let start = 0; start < held; start += 1) {
      let node = root;
      let scan = start;
      let end = -1;
      while (scan < text.length) {
        const next = node.children.get(text[scan]!);
        if (!next) break;
        node = next;
        scan += 1;
        if (node.terminal) end = scan;
      }
      if (scan === text.length && node.children.size > 0) {
        if (!final) held = start;
        else if (redactsPartialSecret(redactPartial, scan - start, node)) end = scan;
      }
      if (end < 0 || start >= held) continue;
      const last = runs.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, end);
      else runs.push({ start, end });
    }
    if (!final) {
      while (runs.length > 0 && runs.at(-1)!.end >= held) held = Math.min(held, runs.pop()!.start);
      if (held > 0 && isHighSurrogate(text, held - 1) && (held === text.length || isLowSurrogate(text, held))) {
        held -= 1;
      }
    }
    let output = "";
    let cursor = 0;
    for (const run of runs) {
      output += `${text.slice(cursor, run.start)}[redacted]`;
      cursor = run.end;
    }
    output += text.slice(cursor, held);
    this.pending = text.slice(held);
    return output;
  }
}

interface SecretRun {
  start: number;
  end: number;
}

function isHighSurrogate(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return unit >= 0xdc00 && unit <= 0xdfff;
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
