import { realpathSync, statSync } from "node:fs";

import {
  MAX_ATTACHMENT_COUNT,
  MAX_IMAGE_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentKind,
  type ChatAttachmentMimeType,
} from "../../../shared/attachments";
import type { ChatAttachment } from "../../../shared/contracts";
import type { ProviderId } from "../../provider/contracts";
import { providerImageRequestLimitError } from "../../provider/provider-image-read";
import type { TurnControllerHooks } from "./turn-controller-types";

export interface CarriedMissedRunImages {
  /** The provider-bound image list: carried images first, then the message's own; undefined when none ride. */
  imagePaths: string[] | undefined;
  /** The carried images' attachment ids, for the provider's read roots. Never part of the persisted message. */
  attachmentIds: string[];
}

interface ImageFact { path: string; size: number; mimeType: ChatAttachmentMimeType }

const NONE: CarriedMissedRunImages = { imagePaths: undefined, attachmentIds: [] };

function ownImageFacts(paths: readonly string[]): ImageFact[] {
  return paths.map((path) => {
    try {
      const canonical = realpathSync(path);
      return { path: canonical, size: statSync(canonical).size, mimeType: "image/png" };
    } catch {
      // Request assembly refuses a missing image of the message itself; this only sizes the room left.
      return { path, size: 0, mimeType: "image/png" };
    }
  });
}

/** The attachment limits and the route's provider image rule (count, and the inline harnesses' byte cap). */
function withinLimits(providerId: ProviderId, images: readonly ImageFact[]): boolean {
  return images.length <= MAX_ATTACHMENT_COUNT
    && images.reduce((total, { size }) => total + size, 0) <= MAX_IMAGE_ATTACHMENT_TOTAL_BYTES
    && providerImageRequestLimitError(providerId, images) === null;
}

/**
 * The images of runs the provider never received that ride on this prompt (T3 `missedAttachments`): `candidates`
 * (oldest run first) without the message's own attachments or repeats by id or file. They go in front of the
 * message's own images, on the provider-bound request only. The message's own images stay whole; carried ones fill
 * the room the attachment and provider image limits leave, newest first, so the oldest are dropped first. Each is
 * checked by the injected hook only when reached, and skipped when missing or unsafe; the walk stops at the first
 * image that no longer fits.
 *
 * Phase 5 (N7): an empty-prompt native resume must become a prompted start when this carries images, as T3's
 * `prompted` does; today every run start sends a prompt.
 */
export function carriedMissedRunImages(input: {
  providerId: ProviderId;
  candidates: readonly ChatAttachment[];
  ownAttachments: readonly ChatAttachment[];
  ownImagePaths: readonly string[] | undefined;
  openCheck: TurnControllerHooks["missedRunImageCheck"];
}): CarriedMissedRunImages {
  if (!input.openCheck || input.candidates.length === 0) return NONE;
  const check = input.openCheck();
  if (!check) return NONE;
  const ownPaths = input.ownImagePaths
    ?? input.ownAttachments.filter(({ mimeType }) => chatAttachmentKind(mimeType) === "image").map(({ path }) => path);
  const own = ownImageFacts(ownPaths);
  const seenIds = new Set(input.ownAttachments.map(({ id }) => id));
  const seenPaths = new Set(own.map(({ path }) => path));
  const carried: (ImageFact & { id: string })[] = [];
  for (let index = input.candidates.length - 1; index >= 0; index -= 1) {
    const attachment = input.candidates[index]!;
    if (chatAttachmentKind(attachment.mimeType) !== "image" || seenIds.has(attachment.id)) continue;
    seenIds.add(attachment.id);
    const checked = check({ attachment });
    if (!checked || seenPaths.has(checked.path)) continue;
    const next = { id: attachment.id, path: checked.path, size: checked.size, mimeType: attachment.mimeType };
    if (!withinLimits(input.providerId, [...own, next, ...carried])) break;
    seenPaths.add(checked.path);
    carried.unshift(next);
  }
  return carried.length === 0 ? NONE : {
    imagePaths: [...carried.map(({ path }) => path), ...ownPaths],
    attachmentIds: carried.map(({ id }) => id),
  };
}
