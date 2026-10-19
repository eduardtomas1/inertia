import { randomUUID } from "node:crypto";

import {
  MAX_APP_EVIDENCE_ENTRIES,
  MAX_APP_EVIDENCE_THUMBNAILS,
  MAX_APP_EVIDENCE_THUMBNAIL_BYTES,
  MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT,
  MAX_APP_EVIDENCE_THUMBNAIL_TOTAL_BYTES,
  MAX_APP_EVIDENCE_THUMBNAIL_WIDTH,
  type AppUnderTestEvidence,
  type AppUnderTestEvidenceKind,
  type AppUnderTestEvidenceWithThumbnail,
} from "../../../shared/app-under-test";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** Fixed evidence wording. Window titles, app output and typed text never appear. */
export const APP_EVIDENCE_LABELS = Object.freeze({
  "launch-agent": "Launched by the agent",
  "launch-user": "Launched by you",
  ready: "First window opened",
  "exit-stopped": "Stopped",
  "exit-code": "Exited",
  "exit-failed": "Could not start",
  click: "Agent clicked a control",
  type: "Agent typed into a control",
  press: "Agent pressed a key",
  scroll: "Agent scrolled a window",
  screenshot: "Screenshot",
} as const);

export type AppEvidenceLabelKey = keyof typeof APP_EVIDENCE_LABELS;

interface StoredEvidence {
  descriptor: AppUnderTestEvidence;
  thumbnail: Uint8Array | null;
}

function validThumbnail(png: Uint8Array, width: number, height: number): boolean {
  return png.byteLength > PNG_SIGNATURE.length
    && png.byteLength <= MAX_APP_EVIDENCE_THUMBNAIL_BYTES
    && PNG_SIGNATURE.every((byte, index) => png[index] === byte)
    && Number.isSafeInteger(width) && width > 0 && width <= MAX_APP_EVIDENCE_THUMBNAIL_WIDTH
    && Number.isSafeInteger(height) && height > 0 && height <= MAX_APP_EVIDENCE_THUMBNAIL_HEIGHT;
}

/**
 * Per-chat, runtime-memory evidence for the App surface. It is never written
 * to SQLite, attachments, diagnostics or provider context. Oldest entries go
 * first; beyond the thumbnail bounds the oldest thumbnails are released while
 * their descriptors stay.
 */
export class AppEvidenceLedger {
  private readonly entries: StoredEvidence[] = [];
  private thumbnailBytes = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  append(input: {
    launchId: string;
    kind: AppUnderTestEvidenceKind;
    label: AppEvidenceLabelKey;
    detail?: string;
    png?: Uint8Array;
    width?: number;
    height?: number;
  }): AppUnderTestEvidence | null {
    let thumbnail: Uint8Array | null = null;
    if (input.png !== undefined) {
      if (!validThumbnail(input.png, input.width ?? 0, input.height ?? 0)) return null;
      thumbnail = Uint8Array.from(input.png);
    }
    const label = input.detail
      ? `${APP_EVIDENCE_LABELS[input.label]} ${input.detail}`
      : APP_EVIDENCE_LABELS[input.label];
    const descriptor: AppUnderTestEvidence = Object.freeze({
      evidenceId: randomUUID(),
      launchId: input.launchId,
      kind: input.kind,
      label,
      at: this.now().toISOString(),
      width: thumbnail ? input.width! : null,
      height: thumbnail ? input.height! : null,
      hasThumbnail: thumbnail !== null,
    });
    this.entries.push({ descriptor, thumbnail });
    if (thumbnail) this.thumbnailBytes += thumbnail.byteLength;
    while (this.entries.length > MAX_APP_EVIDENCE_ENTRIES) this.release(this.entries.shift()!);
    let thumbnails = this.entries.filter((entry) => entry.thumbnail !== null).length;
    for (const entry of this.entries) {
      if (thumbnails <= MAX_APP_EVIDENCE_THUMBNAILS
        && this.thumbnailBytes <= MAX_APP_EVIDENCE_THUMBNAIL_TOTAL_BYTES) break;
      if (!entry.thumbnail) continue;
      this.release(entry);
      thumbnails -= 1;
    }
    return descriptor;
  }

  list(includeThumbnails: false): AppUnderTestEvidence[];
  list(includeThumbnails: true): AppUnderTestEvidenceWithThumbnail[];
  list(includeThumbnails: boolean): AppUnderTestEvidence[] | AppUnderTestEvidenceWithThumbnail[] {
    return this.entries.map(({ descriptor, thumbnail }) => includeThumbnails
      ? {
          ...descriptor,
          hasThumbnail: thumbnail !== null,
          thumbnail: thumbnail ? `data:image/png;base64,${Buffer.from(thumbnail).toString("base64")}` : null,
        }
      : { ...descriptor, hasThumbnail: thumbnail !== null });
  }

  get size(): number {
    return this.entries.length;
  }

  get retainedThumbnailBytes(): number {
    return this.thumbnailBytes;
  }

  clear(): void {
    for (const entry of this.entries) this.release(entry);
    this.entries.length = 0;
  }

  private release(entry: StoredEvidence): void {
    if (!entry.thumbnail) return;
    this.thumbnailBytes -= entry.thumbnail.byteLength;
    entry.thumbnail.fill(0);
    entry.thumbnail = null;
  }
}
