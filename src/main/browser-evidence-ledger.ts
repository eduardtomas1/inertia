import { randomUUID } from "node:crypto";

import {
  browserEvidenceOrigin,
  MAX_BROWSER_EVIDENCE_ENTRIES,
  MAX_BROWSER_EVIDENCE_METADATA_BYTES,
  MAX_BROWSER_EVIDENCE_SCREENSHOTS,
  MAX_BROWSER_EVIDENCE_THUMBNAIL_BYTES,
  MAX_BROWSER_EVIDENCE_THUMBNAIL_TOTAL_BYTES,
  sanitizeBrowserEvidenceText,
  type BrowserEvidenceEntry,
  type BrowserEvidenceImage,
  type BrowserEvidenceKind,
  type BrowserEvidenceSnapshot,
} from "../shared/browser-evidence.js";

export interface BrowserEvidenceAuthority {
  runId: string;
  turnId: string;
}

interface BrowserEvidenceLocation {
  tabId: string;
  pageNumber: number;
  documentSequence: number;
  authority?: BrowserEvidenceAuthority;
  occurredAt?: string;
  occurrenceSequence?: number;
}

interface BrowserEvidenceRecord extends BrowserEvidenceLocation {
  kind: BrowserEvidenceKind;
  summary: string;
  detail?: string | null;
  origin?: string | null;
  redacted?: boolean;
  screenshot?: {
    data: string | null;
    width: number;
    height: number;
  };
}

const SAFE_METHODS = new Set([
  "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT",
]);
const SAFE_RESOURCE_TYPES = new Set([
  "mainFrame", "subFrame", "stylesheet", "script", "image", "font",
  "object", "xhr", "ping", "cspReport", "media", "webSocket", "other",
]);
const SAFE_NET_ERROR = /^net::ERR_[A-Z0-9_]{1,72}$/u;

function safeMethod(value: unknown): string {
  return typeof value === "string" && SAFE_METHODS.has(value.toUpperCase())
    ? value.toUpperCase()
    : "REQUEST";
}

function safeResourceType(value: unknown): string {
  return typeof value === "string" && SAFE_RESOURCE_TYPES.has(value)
    ? value
    : "resource";
}

function safeNetworkOutcome(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599) {
    return `HTTP ${value}`;
  }
  return typeof value === "string" && SAFE_NET_ERROR.test(value)
    ? value.slice("net::".length).replaceAll("_", " ").toLowerCase()
    : "request failed";
}

function metadataBytes(entry: BrowserEvidenceEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

function compareOccurrence(
  left: BrowserEvidenceEntry,
  right: BrowserEvidenceEntry,
): number {
  return left.occurredAt.localeCompare(right.occurredAt)
    || left.sequence - right.sequence;
}

export class BrowserEvidenceLedger {
  readonly #entries: BrowserEvidenceEntry[] = [];
  readonly #entryBytes = new Map<string, number>();
  readonly #lastOccurrenceSequence = new Map<string, number>();
  readonly #images = new Map<string, { data: string; bytes: number }>();
  #metadataBytes = 0;
  #imageBytes = 0;
  #revision = 0;
  #sequence = 0;
  #omitted = false;

  snapshot(): BrowserEvidenceSnapshot {
    return {
      revision: this.#revision,
      entries: this.#entries
        .slice()
        .sort(compareOccurrence)
        .map((entry) => ({
          ...entry,
          ...(entry.screenshot ? { screenshot: { ...entry.screenshot } } : {}),
        })),
      omitted: this.#omitted,
    };
  }

  revision(): number {
    return this.#revision;
  }

  markOmitted(): boolean {
    if (this.#omitted) return false;
    this.#omitted = true;
    this.#revision += 1;
    return true;
  }

  recordNavigation(input: BrowserEvidenceLocation & {
    url: unknown;
    sameDocument: boolean;
  }): BrowserEvidenceEntry {
    const origin = browserEvidenceOrigin(input.url);
    return this.#append({
      ...input,
      kind: "navigation",
      summary: input.sameDocument ? "History changed" : "Page navigated",
      detail: origin ? `Destination ${origin}` : "Destination details hidden",
      origin,
      redacted: origin === null,
    });
  }

  recordConsoleError(input: BrowserEvidenceLocation & {
    message: unknown;
    sensitiveDocument?: boolean;
  }): BrowserEvidenceEntry {
    const detail = input.sensitiveDocument
      ? { text: "Sensitive console detail hidden", redacted: true }
      : sanitizeBrowserEvidenceText(
          input.message,
          "Sensitive console detail hidden",
        );
    return this.#append({
      ...input,
      kind: "console-error",
      summary: "Console error",
      detail: detail.text,
      redacted: detail.redacted,
    });
  }

  recordNetworkFailure(input: BrowserEvidenceLocation & {
    url: unknown;
    method: unknown;
    resourceType: unknown;
    outcome: unknown;
  }): BrowserEvidenceEntry {
    const method = safeMethod(input.method);
    const resource = safeResourceType(input.resourceType);
    const outcome = safeNetworkOutcome(input.outcome);
    const origin = browserEvidenceOrigin(input.url);
    return this.#append({
      ...input,
      kind: "network-failure",
      summary: `${method} ${resource} failed`,
      detail: origin ? `${outcome} · ${origin}` : `${outcome} · origin hidden`,
      origin,
      redacted: origin === null,
    });
  }

  recordAgentAction(input: BrowserEvidenceLocation & {
    summary: unknown;
  }): BrowserEvidenceEntry {
    const summary = sanitizeBrowserEvidenceText(
      input.summary,
      "Agent controlled this page",
      240,
    );
    return this.#append({
      ...input,
      kind: "agent-action",
      summary: summary.text,
      redacted: summary.redacted,
    });
  }

  recordScreenshot(input: BrowserEvidenceLocation & {
    url: unknown;
    data: string | null;
    width: number;
    height: number;
  }): BrowserEvidenceEntry {
    const origin = browserEvidenceOrigin(input.url);
    return this.#append({
      ...input,
      kind: "screenshot",
      summary: "Agent captured a screenshot",
      detail: origin ? `Captured ${origin}` : "Page location hidden",
      origin,
      redacted: origin === null,
      screenshot: {
        data: input.data,
        width: input.width,
        height: input.height,
      },
    });
  }

  image(id: string): BrowserEvidenceImage | null {
    const image = this.#images.get(id);
    return image ? { mimeType: "image/png", data: image.data } : null;
  }

  clear(): void {
    this.#entries.splice(0);
    this.#entryBytes.clear();
    this.#lastOccurrenceSequence.clear();
    this.#images.clear();
    this.#metadataBytes = 0;
    this.#imageBytes = 0;
    this.#revision += 1;
  }

  #append(record: BrowserEvidenceRecord): BrowserEvidenceEntry {
    const occurredAt = record.occurredAt ?? new Date().toISOString();
    const occurrenceSequence = record.occurrenceSequence ?? this.#sequence + 1;
    this.#sequence = Math.max(this.#sequence, occurrenceSequence);
    let adjacent: BrowserEvidenceEntry | undefined;
    for (const entry of this.#entries) {
      const entryOccurrenceSequence = this.#lastOccurrenceSequence.get(entry.id)
        ?? entry.sequence;
      if (
        (
          entry.occurredAt.localeCompare(occurredAt)
          || entryOccurrenceSequence - occurrenceSequence
        ) < 0
        && (
          !adjacent
          || adjacent.occurredAt.localeCompare(entry.occurredAt) < 0
          || (
            adjacent.occurredAt === entry.occurredAt
            && (this.#lastOccurrenceSequence.get(adjacent.id) ?? adjacent.sequence)
              < entryOccurrenceSequence
          )
        )
      ) adjacent = entry;
    }
    if (
      adjacent
      && record.kind !== "screenshot"
      && adjacent.kind === record.kind
      && adjacent.tabId === record.tabId
      && adjacent.documentSequence === record.documentSequence
      && adjacent.runId === (record.authority?.runId ?? null)
      && adjacent.turnId === (record.authority?.turnId ?? null)
      && adjacent.summary === record.summary
      && adjacent.detail === (record.detail ?? null)
      && adjacent.origin === (record.origin ?? null)
      && adjacent.occurrences < 999
    ) {
      this.#metadataBytes -= this.#entryBytes.get(adjacent.id) ?? 0;
      adjacent.occurrences += 1;
      adjacent.occurredAt = occurredAt;
      this.#lastOccurrenceSequence.set(adjacent.id, occurrenceSequence);
      const bytes = metadataBytes(adjacent);
      this.#entryBytes.set(adjacent.id, bytes);
      this.#metadataBytes += bytes;
      this.#boundEntries();
      this.#revision += 1;
      return { ...adjacent };
    }
    const screenshotData = record.screenshot?.data ?? null;
    const screenshotBytes = screenshotData
      ? Buffer.byteLength(screenshotData, "base64")
      : 0;
    const screenshotAvailable = Boolean(
      screenshotData
      && screenshotBytes > 0
      && screenshotBytes <= MAX_BROWSER_EVIDENCE_THUMBNAIL_BYTES,
    );
    const entry: BrowserEvidenceEntry = {
      id: randomUUID(),
      sequence: occurrenceSequence,
      kind: record.kind,
      tabId: record.tabId,
      pageNumber: record.pageNumber,
      documentSequence: record.documentSequence,
      runId: record.authority?.runId ?? null,
      turnId: record.authority?.turnId ?? null,
      occurredAt,
      summary: record.summary.slice(0, 240),
      detail: record.detail?.slice(0, 600) ?? null,
      origin: record.origin?.slice(0, 300) ?? null,
      redacted: record.redacted ?? false,
      occurrences: 1,
      ...(record.screenshot ? {
        screenshot: {
          available: screenshotAvailable,
          width: Math.max(1, Math.min(Math.trunc(record.screenshot.width), 4_096)),
          height: Math.max(1, Math.min(Math.trunc(record.screenshot.height), 4_096)),
        },
      } : {}),
    };
    this.#entries.push(entry);
    this.#lastOccurrenceSequence.set(entry.id, occurrenceSequence);
    const bytes = metadataBytes(entry);
    this.#entryBytes.set(entry.id, bytes);
    this.#metadataBytes += bytes;
    if (screenshotAvailable && screenshotData) {
      this.#images.set(entry.id, { data: screenshotData, bytes: screenshotBytes });
      this.#imageBytes += screenshotBytes;
      this.#boundImages();
    }
    this.#boundEntries();
    this.#revision += 1;
    return { ...entry };
  }

  #boundEntries(): void {
    while (
      this.#entries.length > MAX_BROWSER_EVIDENCE_ENTRIES
      || this.#metadataBytes > MAX_BROWSER_EVIDENCE_METADATA_BYTES
    ) {
      let oldestIndex = 0;
      for (let index = 1; index < this.#entries.length; index += 1) {
        if (compareOccurrence(this.#entries[index]!, this.#entries[oldestIndex]!) < 0) {
          oldestIndex = index;
        }
      }
      const [removed] = this.#entries.splice(oldestIndex, 1);
      if (!removed) break;
      this.#metadataBytes -= this.#entryBytes.get(removed.id) ?? 0;
      this.#entryBytes.delete(removed.id);
      this.#lastOccurrenceSequence.delete(removed.id);
      this.#dropImage(removed.id);
      this.#omitted = true;
    }
  }

  #boundImages(): void {
    while (
      this.#images.size > MAX_BROWSER_EVIDENCE_SCREENSHOTS
      || this.#imageBytes > MAX_BROWSER_EVIDENCE_THUMBNAIL_TOTAL_BYTES
    ) {
      const oldestId = this.#images.keys().next().value;
      if (typeof oldestId !== "string") break;
      this.#dropImage(oldestId);
      const entry = this.#entries.find((candidate) => candidate.id === oldestId);
      if (entry?.screenshot) {
        this.#metadataBytes -= this.#entryBytes.get(entry.id) ?? 0;
        entry.screenshot.available = false;
        const bytes = metadataBytes(entry);
        this.#entryBytes.set(entry.id, bytes);
        this.#metadataBytes += bytes;
      }
      this.#omitted = true;
    }
  }

  #dropImage(id: string): void {
    const image = this.#images.get(id);
    if (!image) return;
    this.#images.delete(id);
    this.#imageBytes -= image.bytes;
  }
}
