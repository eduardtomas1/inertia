import { createHash } from "node:crypto";

import type { BrowserEvidenceImage } from "../shared/browser-evidence.js";

export interface BrowserEvidenceImageApprovalRequest {
  evidenceId: string;
  fingerprint: string;
}

export type BrowserEvidenceImageApproval = (
  request: BrowserEvidenceImageApprovalRequest,
) => Promise<boolean>;

export interface BrowserEvidenceImageInspectionHandle {
  show(): boolean;
  close(): void;
}

export type BrowserEvidenceImageInspection = (
  image: BrowserEvidenceImage,
) => Promise<BrowserEvidenceImageInspectionHandle | null>;

function imageFingerprint(image: BrowserEvidenceImage): string {
  return createHash("sha256")
    .update(image.mimeType, "utf8")
    .update("\0", "utf8")
    .update(Buffer.from(image.data, "base64"))
    .digest("hex");
}

/**
 * Inspects one exact local thumbnail only after a post-capture user decision.
 * The second lookup prevents an approval from being redeemed for replaced or
 * evicted bytes while the native confirmation was open. The image is consumed
 * by a main-owned inspector and is never returned to the application renderer.
 */
export async function approvedBrowserEvidenceImage(
  evidenceId: string,
  lookup: () => BrowserEvidenceImage | null,
  requestApproval: BrowserEvidenceImageApproval,
  inspect: BrowserEvidenceImageInspection,
): Promise<BrowserEvidenceImageInspectionHandle | null> {
  const captured = lookup();
  if (!captured) return null;
  const fingerprint = imageFingerprint(captured);
  if (!await requestApproval({ evidenceId, fingerprint })) return null;
  const current = lookup();
  if (!current || imageFingerprint(current) !== fingerprint) return null;
  const handle = await inspect(current);
  if (!handle) return null;
  const final = lookup();
  if (final && imageFingerprint(final) === fingerprint) return handle;
  handle.close();
  return null;
}

export class BrowserEvidenceInspectorRegistry {
  readonly #handles = new Map<string, BrowserEvidenceImageInspectionHandle>();
  #generation = 0;

  async inspect(
    evidenceId: string,
    lookup: () => BrowserEvidenceImage | null,
    requestApproval: BrowserEvidenceImageApproval,
    open: BrowserEvidenceImageInspection,
  ): Promise<boolean> {
    this.close(evidenceId);
    const generation = this.#generation;
    const handle = await approvedBrowserEvidenceImage(
      evidenceId, lookup, requestApproval, open,
    );
    if (!handle) return false;
    if (this.#generation !== generation || !lookup()) {
      handle.close();
      return false;
    }
    this.#handles.set(evidenceId, handle);
    if (handle.show()) return true;
    this.#handles.delete(evidenceId);
    handle.close();
    return false;
  }

  close(evidenceId?: string): void {
    this.#generation += 1;
    const entries = evidenceId
      ? [[evidenceId, this.#handles.get(evidenceId)] as const]
      : [...this.#handles.entries()];
    for (const [id, handle] of entries) {
      if (!handle) continue;
      this.#handles.delete(id);
      handle.close();
    }
  }

  closeUnavailable(available: (evidenceId: string) => boolean): void {
    for (const evidenceId of this.#handles.keys()) {
      if (!available(evidenceId)) this.close(evidenceId);
    }
  }
}
