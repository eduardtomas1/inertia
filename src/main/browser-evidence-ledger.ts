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

export class BrowserEvidenceLedger {
  readonly #entries: BrowserEvidenceEntry[] = [];
  readonly #entryBytes = new Map<string, number>();
  readonly #images = new Map<string, { data: string; bytes: number }>();
  #metadataBytes = 0;
  #imageBytes = 0;
  #revision = 0;
  #sequence = 0;
  #omitted = false;

  snapshot(): BrowserEvidenceSnapshot {
    return {
      revision: this.#revision,
      entries: this.#entries.map((entry) => ({
        ...entry,
        ...(entry.screenshot ? { screenshot: { ...entry.screenshot } } : {}),
      })),
      omitted: this.#omitted,
    };
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
    this.#images.clear();
    this.#metadataBytes = 0;
    this.#imageBytes = 0;
    this.#revision += 1;
  }

  #append(record: BrowserEvidenceRecord): BrowserEvidenceEntry {
    const last = this.#entries.at(-1);
    if (
      last
      && record.kind !== "screenshot"
      && last.kind === record.kind
      && last.tabId === record.tabId
      && last.documentSequence === record.documentSequence
      && last.runId === (record.authority?.runId ?? null)
      && last.turnId === (record.authority?.turnId ?? null)
      && last.summary === record.summary
      && last.detail === (record.detail ?? null)
      && last.origin === (record.origin ?? null)
      && last.occurrences < 999
    ) {
      this.#metadataBytes -= this.#entryBytes.get(last.id) ?? 0;
      last.occurrences += 1;
      last.occurredAt = record.occurredAt ?? new Date().toISOString();
      const bytes = metadataBytes(last);
      this.#entryBytes.set(last.id, bytes);
      this.#metadataBytes += bytes;
      this.#boundEntries();
      this.#revision += 1;
      return { ...last };
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
      sequence: this.#sequence += 1,
      kind: record.kind,
      tabId: record.tabId,
      pageNumber: record.pageNumber,
      documentSequence: record.documentSequence,
      runId: record.authority?.runId ?? null,
      turnId: record.authority?.turnId ?? null,
      occurredAt: record.occurredAt ?? new Date().toISOString(),
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
      const removed = this.#entries.shift();
      if (!removed) break;
      this.#metadataBytes -= this.#entryBytes.get(removed.id) ?? 0;
      this.#entryBytes.delete(removed.id);
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
