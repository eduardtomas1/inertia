import { createHash } from "node:crypto";

import {
  remoteSanitizerInspectionWindow,
  sanitizeRemoteContent,
} from "../shared/remote-sanitizer";

export interface SanitizedCacheEntry {
  fingerprint: string;
  value: string;
  retainedBytes: number;
}

export const REMOTE_TRANSCRIPT_CACHE_BUDGET_BYTES = 8 * 1024 * 1024;

const CHARACTER_BYTES = 2;
const ENTRY_OVERHEAD_BYTES = 96;
const KEY_SEPARATOR = ":";

function qualified(first: string, second: string): string {
  return `${first.length}${KEY_SEPARATOR}${first}${second}`;
}

function entryBytes(
  key: string,
  entry: Omit<SanitizedCacheEntry, "retainedBytes">,
): number {
  return ENTRY_OVERHEAD_BYTES
    + CHARACTER_BYTES
      * (key.length + entry.fingerprint.length + entry.value.length);
}

export function remoteTranscriptFingerprint(source: string): string {
  const inspected = remoteSanitizerInspectionWindow(source);
  return createHash("sha256")
    .update(`${inspected.length}${KEY_SEPARATOR}`)
    .update(inspected)
    .digest("hex");
}

interface RemoteTranscriptCacheOptions {
  budgetBytes?: number;
  sanitize?(source: string): string;
  fingerprint?(source: string): string;
}

export class RemoteTranscriptCache {
  private readonly entries = new Map<string, SanitizedCacheEntry>();
  private readonly budgetBytes: number;
  private readonly sanitize: (source: string) => string;
  private readonly fingerprint: (source: string) => string;
  private bytes = 0;

  constructor(options: RemoteTranscriptCacheOptions = {}) {
    this.budgetBytes = Math.max(
      0,
      options.budgetBytes ?? REMOTE_TRANSCRIPT_CACHE_BUDGET_BYTES,
    );
    this.sanitize = options.sanitize
      ?? ((source) => sanitizeRemoteContent(source));
    this.fingerprint = options.fingerprint ?? remoteTranscriptFingerprint;
  }

  content(conversationId: string, messageId: string, source: string): string {
    const key = qualified(conversationId, messageId);
    const fingerprint = this.fingerprint(source);
    const cached = this.entries.get(key);
    if (cached) {
      if (cached.fingerprint === fingerprint) {
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.value;
      }
      this.remove(key);
    }
    const value = this.sanitize(source);
    const retainedBytes = entryBytes(key, { fingerprint, value });
    if (retainedBytes <= this.budgetBytes) {
      this.entries.set(key, { fingerprint, value, retainedBytes });
      this.bytes += retainedBytes;
      this.evict();
    }
    return value;
  }

  invalidateMessage(conversationId: string, messageId: string): void {
    this.remove(qualified(conversationId, messageId));
  }

  invalidateConversation(conversationId: string): void {
    const prefix = qualified(conversationId, "");
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.remove(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  retainedBytes(): number {
    return this.bytes;
  }

  size(): number {
    return this.entries.size;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.retainedBytes;
  }

  private evict(): void {
    for (const key of this.entries.keys()) {
      if (this.bytes <= this.budgetBytes) return;
      this.remove(key);
    }
  }
}
