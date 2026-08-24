import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { approvedBrowserEvidenceImage } from "../../src/main/browser-evidence-image-approval";
import type { BrowserEvidenceImage } from "../../src/shared/browser-evidence";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const first: BrowserEvidenceImage = {
  mimeType: "image/png",
  data: Buffer.from("first-local-thumbnail").toString("base64"),
};

describe("Browser evidence image approval", () => {
  it("does not prompt or release bytes after evidence eviction", async () => {
    const approve = vi.fn(async () => true);
    const inspect = vi.fn(async () => ({ show: () => true, close: vi.fn() }));
    await expect(approvedBrowserEvidenceImage(
      evidenceId, () => null, approve, inspect,
    )).resolves.toBeNull();
    expect(approve).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("binds the native decision to the exact immutable thumbnail", async () => {
    let current: BrowserEvidenceImage | null = first;
    const approve = vi.fn(async (request: { evidenceId: string; fingerprint: string }) => {
      expect(request).toEqual({
        evidenceId,
        fingerprint: createHash("sha256")
          .update("image/png\0", "utf8")
          .update(Buffer.from("first-local-thumbnail"))
          .digest("hex"),
      });
      return true;
    });
    await expect(approvedBrowserEvidenceImage(
      evidenceId,
      () => current,
      approve,
      async (image) => image === first
        ? { show: () => true, close: vi.fn() }
        : null,
    )).resolves.toEqual({ show: expect.any(Function), close: expect.any(Function) });

    current = {
      mimeType: "image/png",
      data: Buffer.from("replacement-thumbnail").toString("base64"),
    };
    await expect(approvedBrowserEvidenceImage(
      evidenceId,
      () => current,
      async () => {
        current = first;
        return true;
      },
      async () => ({ show: () => true, close: vi.fn() }),
    )).resolves.toBeNull();
  });

  it("returns no bytes when the user cancels", async () => {
    await expect(approvedBrowserEvidenceImage(
      evidenceId,
      () => first,
      async () => false,
      async () => ({ show: () => true, close: vi.fn() }),
    )).resolves.toBeNull();
  });

  it("destroys a prepared inspector when the exact image changes during setup", async () => {
    let current: BrowserEvidenceImage | null = first;
    const close = vi.fn();
    await expect(approvedBrowserEvidenceImage(
      evidenceId,
      () => current,
      async () => true,
      async () => {
        current = {
          mimeType: "image/png",
          data: Buffer.from("replacement-thumbnail").toString("base64"),
        };
        return { show: () => true, close };
      },
    )).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
  });
});
