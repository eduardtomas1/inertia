import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { redactHostToolPayload } from "./host-tool-redaction";

const CREDENTIAL_ENVIRONMENT_KEY =
  /(?:^|[._-])(?:api[._-]?key|auth(?:entication|orization|[._-]key)|cookie|credentials?|(?:access|client|encryption|private|secret|service|signing|subscription)[._-]?key(?:[._-]?id)?|pass(?:code|phrase|word)?|passwd|private[._-]?key|pwd|secret|token)(?:$|[._-])/iu;
export const SIGNIFICANT_SECRET_PREFIX_CHARS = 6;
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
  private matcher: SecretMatcher;
  private readonly assistant: BoundarySecretRedactor;
  private readonly reasoning: BoundarySecretRedactor;
  private readonly stderr: BoundarySecretRedactor;

  constructor(environment: NodeJS.ProcessEnv) {
    this.matcher = new SecretMatcher(acpEnvironmentSecretValues(environment));
    this.assistant = new BoundarySecretRedactor(() => this.matcher);
    this.reasoning = new BoundarySecretRedactor(() => this.matcher);
    this.stderr = new BoundarySecretRedactor(() => this.matcher);
  }

  addSecrets(values: readonly string[]): void {
    const merged = normalizedSecrets([...this.matcher.secrets, ...values]);
    if (!this.matcher.matches(merged)) this.matcher = new SecretMatcher(merged);
  }

  payload<T>(value: T): T {
    return redactHostToolPayload(value, this.matcher.secrets);
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

  flushAssistant(): string {
    return this.assistant.flush("significant");
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

export interface CachedEdgePattern {
  readonly forward: string;
  readonly forwardFailure: Int32Array;
  readonly reverse: string;
  readonly reverseFailure: Int32Array;
  readonly length: number;
}

export class SecretMatcher {
  static readonly empty = new SecretMatcher([]);
  readonly secrets: readonly string[];
  private trie: SecretTrieNode | undefined;
  private cachedEdges: readonly CachedEdgePattern[] | undefined;

  constructor(secrets: readonly string[]) {
    this.secrets = Object.freeze([...secrets]);
  }

  get root(): SecretTrieNode {
    return this.trie ??= secretTrie(this.secrets);
  }

  get edgePatterns(): readonly CachedEdgePattern[] {
    return this.cachedEdges ??= this.secrets.map((secret) => {
      const reverse = reverseString(secret);
      return {
        forward: secret,
        forwardFailure: buildKmpFailure(secret),
        reverse,
        reverseFailure: buildKmpFailure(reverse),
        length: secret.length,
      };
    });
  }

  redact(text: string): string {
    if (!text) return text;
    const root = this.root;
    if (root.children.size === 0) return text;
    const rootAscii = root.ascii;
    let node = root;
    const runs: SecretRun[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      while (node !== root) {
        const next = node.children.get(code);
        if (next !== undefined) {
          node = next;
          break;
        }
        node = node.fail;
      }
      if (node === root) {
        const next = code < 128 ? rootAscii[code] : root.children.get(code);
        if (next !== undefined) node = next;
      }
      if (node.longestMatch > 0) {
        const end = index + 1;
        let start = end - node.longestMatch;
        while (runs.length > 0 && runs[runs.length - 1]!.end > start) {
          const popped = runs.pop()!;
          if (popped.start < start) start = popped.start;
        }
        runs.push({ start, end });
      }
    }
    if (runs.length === 0) return text;
    let output = "";
    let cursor = 0;
    for (const run of runs) {
      output += `${text.slice(cursor, run.start)}[redacted]`;
      cursor = run.end;
    }
    return cursor < text.length ? output + text.slice(cursor) : output;
  }

  matches(secrets: readonly string[]): boolean {
    return secrets.length === this.secrets.length && secrets.every((secret, index) => secret === this.secrets[index]);
  }
}

export class BoundarySecretRedactor {
  private pending = "";
  private finished = false;

  constructor(private readonly matcher: () => SecretMatcher) {}

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

  flush(redactPartial: PartialSecretRedaction): string {
    return this.finished ? "" : this.drain(true, redactPartial);
  }

  discard(): void {
    this.pending = "";
    this.finished = true;
  }

  private drain(final: boolean, redactPartial?: PartialSecretRedaction): string {
    const root = this.matcher().root;
    const text = this.pending;
    if (root.children.size === 0) {
      this.pending = "";
      return text;
    }
    const rootAscii = root.ascii;
    const runs: SecretRun[] = [];
    let node = root;
    const length = text.length;
    for (let index = 0; index < length; index += 1) {
      const code = text.charCodeAt(index);
      while (node !== root) {
        const next = node.children.get(code);
        if (next !== undefined) {
          node = next;
          break;
        }
        node = node.fail;
      }
      if (node === root) {
        const next = code < 128 ? rootAscii[code] : root.children.get(code);
        if (next !== undefined) node = next;
      }
      if (node.longestMatch > 0) {
        const end = index + 1;
        let start = end - node.longestMatch;
        while (runs.length > 0 && runs[runs.length - 1]!.end >= start) {
          const popped = runs.pop()!;
          if (popped.start < start) start = popped.start;
        }
        runs.push({ start, end });
      }
    }
    let held = length;
    if (!final) {
      let suffix = node;
      while (suffix !== root) {
        if (suffix.children.size > 0) {
          held = length - suffix.depth;
          break;
        }
        suffix = suffix.fail;
      }
      while (runs.length > 0 && runs[runs.length - 1]!.end >= held) {
        held = Math.min(held, runs.pop()!.start);
      }
      if (held > 0 && isHighSurrogate(text, held - 1) && (held === length || isLowSurrogate(text, held))) {
        held -= 1;
      }
    } else if (redactPartial !== undefined) {
      let suffix = node;
      while (suffix !== root) {
        if (suffix.children.size > 0 && redactsPartialSecret(redactPartial, suffix.depth, suffix)) {
          let start = length - suffix.depth;
          while (runs.length > 0 && runs[runs.length - 1]!.end >= start) {
            const popped = runs.pop()!;
            if (popped.start < start) start = popped.start;
          }
          runs.push({ start, end: length });
          break;
        }
        suffix = suffix.fail;
      }
    }
    if (runs.length === 0) {
      const output = held === length ? text : text.slice(0, held);
      this.pending = held === length ? "" : text.slice(held);
      return output;
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

export type PartialSecretRedaction = "all" | "significant";

interface SecretTrieNode {
  readonly children: Map<number, SecretTrieNode>;
  readonly ascii: (SecretTrieNode | undefined)[];
  readonly depth: number;
  fail: SecretTrieNode;
  terminal: boolean;
  longestMatch: number;
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

function buildKmpFailure(pattern: string): Int32Array {
  const failure = new Int32Array(pattern.length);
  for (let index = 1, matched = 0; index < pattern.length; index += 1) {
    while (matched > 0 && pattern.charCodeAt(index) !== pattern.charCodeAt(matched)) {
      matched = failure[matched - 1]!;
    }
    if (pattern.charCodeAt(index) === pattern.charCodeAt(matched)) matched += 1;
    failure[index] = matched;
  }
  return failure;
}

function reverseString(value: string): string {
  let out = "";
  for (let index = value.length - 1; index >= 0; index -= 1) {
    out += value[index]!;
  }
  return out;
}

function secretTrie(secrets: readonly string[]): SecretTrieNode {
  const rootAscii = Array.from<SecretTrieNode | undefined>({ length: 128 });
  const root: SecretTrieNode = {
    children: new Map(),
    ascii: rootAscii,
    depth: 0,
    fail: null as unknown as SecretTrieNode,
    terminal: false,
    longestMatch: 0,
    shortestSecret: Infinity,
  };
  root.fail = root;
  const emptyAscii: (SecretTrieNode | undefined)[] = [];
  for (const secret of secrets) {
    let node = root;
    for (let index = 0; index < secret.length; index += 1) {
      const code = secret.charCodeAt(index);
      let child = node === root && code < 128 ? rootAscii[code] : node.children.get(code);
      if (!child) {
        child = {
          children: new Map(),
          ascii: emptyAscii,
          depth: index + 1,
          fail: root,
          terminal: false,
          longestMatch: 0,
          shortestSecret: secret.length,
        };
        node.children.set(code, child);
        if (node === root && code < 128) rootAscii[code] = child;
      } else if (secret.length < child.shortestSecret) {
        child.shortestSecret = secret.length;
      }
      node = child;
    }
    node.terminal = true;
    node.longestMatch = secret.length;
  }
  // Build Aho-Corasick failure links in BFS order.
  const queue: SecretTrieNode[] = [];
  for (const child of root.children.values()) {
    child.fail = root;
    queue.push(child);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    for (const [code, child] of current.children) {
      let fallback = current.fail;
      while (fallback !== root && !fallback.children.has(code)) {
        fallback = fallback.fail;
      }
      const target = fallback === root && code < 128
        ? rootAscii[code]
        : fallback.children.get(code);
      child.fail = target ?? root;
      if (child.fail.longestMatch > child.longestMatch) {
        child.longestMatch = child.fail.longestMatch;
      }
      queue.push(child);
    }
  }
  return root;
}
