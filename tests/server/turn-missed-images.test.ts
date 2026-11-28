// @inertia-test-suite portable
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { carriedMissedRunImages } from "../../src/server/runtime/turns/turn-missed-images";
import type { ChatAttachment } from "../../src/shared/contracts";

const MIB = 1024 * 1024;
const ROOT = join("/", "retained");

function candidate(index: number, size: number): ChatAttachment {
  const id = `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`;
  return { id, name: `missed-${index}.png`, path: id, mimeType: "image/png", size };
}

/** A check that accepts every image at its declared size, counting how often it is opened and called. */
function counting() {
  const check = vi.fn(({ attachment }: { attachment: ChatAttachment }) =>
    ({ path: join(ROOT, attachment.id, `${attachment.id}.png`), size: attachment.size }));
  const openCheck = vi.fn(() => check);
  return { check, openCheck };
}

describe("missed-run images carried on a prompt", () => {
  it("keeps an inline harness's 20 MiB request cap, dropping the oldest first (OpenCode 2 inlines images)", () => {
    const candidates = [0, 1, 2].map((index) => candidate(index, 8 * MIB));
    for (const providerId of ["opencode", "claude"] as const) {
      const carried = carriedMissedRunImages({ providerId, candidates, ownAttachments: [], ownImagePaths: [],
        openCheck: counting().openCheck });
      expect(carried.attachmentIds).toEqual([candidates[1]!.id, candidates[2]!.id]);
    }
    // Codex reads local image paths: only the 80 MiB attachment total applies.
    const codex = carriedMissedRunImages({ providerId: "codex", candidates, ownAttachments: [], ownImagePaths: [],
      openCheck: counting().openCheck });
    expect(codex.attachmentIds).toEqual(candidates.map(({ id }) => id));
  });

  it("opens one check per turn and stops checking at the first image that no longer fits", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => candidate(index, 1_000));
    const { check, openCheck } = counting();
    // 30 of the message's own images leave room for two of the 32 Codex accepts.
    const own = Array.from({ length: 30 }, (_, index) => join(ROOT, "own", `${index}.png`));
    const carried = carriedMissedRunImages({ providerId: "codex", candidates, ownAttachments: [], ownImagePaths: own,
      openCheck });
    expect(carried.attachmentIds).toEqual([candidates[38]!.id, candidates[39]!.id]);
    expect(carried.imagePaths).toEqual([...carried.attachmentIds.map((id) => join(ROOT, id, `${id}.png`)), ...own]);
    expect(openCheck).toHaveBeenCalledOnce();
    expect(check).toHaveBeenCalledTimes(3);
  });
});
