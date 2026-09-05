import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { InertiaReleaseChannel } from "./release-channel.js";

export const APPIMAGE_UPDATE_JOURNAL_SCHEMA = 1;

export interface AppImageFileIdentity {
  dev: string;
  ino: string;
}

export interface PreparingAppImageJournal {
  schema: typeof APPIMAGE_UPDATE_JOURNAL_SCHEMA;
  channel: InertiaReleaseChannel;
  phase: "preparing";
  originalName: string;
  stableName: string;
  original: AppImageFileIdentity;
}

export interface PreparedAppImageJournal extends
  Omit<PreparingAppImageJournal, "phase"> {
  phase: "prepared";
  candidate: AppImageFileIdentity;
}

export interface AppImageHandoffJournal {
  schema: 2;
  channel: InertiaReleaseChannel;
  phase: "staged" | "ownership-committed";
  operationId: string;
  originalName: string;
  stableName: string;
  original: AppImageFileIdentity;
  candidate: AppImageFileIdentity;
  candidateArtifactDigest: string;
  candidateExecutableIdentityDigest: string;
  checksum: string;
}

export type AppImageUpdateJournal =
  | PreparingAppImageJournal
  | PreparedAppImageJournal
  | AppImageHandoffJournal;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function validIdentity(value: unknown): value is AppImageFileIdentity {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "dev\0ino"
    && typeof (value as AppImageFileIdentity).dev === "string"
    && /^(?:0|[1-9]\d*)$/u.test((value as AppImageFileIdentity).dev)
    && typeof (value as AppImageFileIdentity).ino === "string"
    && /^(?:0|[1-9]\d*)$/u.test((value as AppImageFileIdentity).ino);
}

function handoffJournalPayload(
  value: Omit<AppImageHandoffJournal, "checksum">,
): Omit<AppImageHandoffJournal, "checksum"> {
  // Keep this explicit field order stable: it is the persisted checksum
  // contract shared by old-version recovery and candidate bootstrap.
  return {
    schema: 2,
    channel: value.channel,
    phase: value.phase,
    operationId: value.operationId,
    originalName: value.originalName,
    stableName: value.stableName,
    original: { ...value.original },
    candidate: { ...value.candidate },
    candidateArtifactDigest: value.candidateArtifactDigest,
    candidateExecutableIdentityDigest: value.candidateExecutableIdentityDigest,
  };
}

export function appImageHandoffJournalChecksum(
  value: Omit<AppImageHandoffJournal, "checksum">,
): string {
  return createHash("sha256")
    .update("inertia.appimage-update-handoff.v2\0", "utf8")
    .update(JSON.stringify(handoffJournalPayload(value)), "utf8")
    .digest("hex");
}

export function createAppImageHandoffJournal(
  value: Omit<AppImageHandoffJournal, "schema" | "checksum">,
): AppImageHandoffJournal {
  const payload = handoffJournalPayload({ schema: 2, ...value });
  return {
    ...payload,
    checksum: appImageHandoffJournalChecksum(payload),
  };
}

function validHandoffJournal(
  value: unknown,
): value is AppImageHandoffJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AppImageHandoffJournal>;
  if (
    Object.keys(value).sort().join("\0") !== [
      "candidate",
      "candidateArtifactDigest",
      "candidateExecutableIdentityDigest",
      "channel",
      "checksum",
      "operationId",
      "original",
      "originalName",
      "phase",
      "schema",
      "stableName",
    ].join("\0")
    || candidate.schema !== 2
    || (candidate.channel !== "stable" && candidate.channel !== "canary")
    || (candidate.phase !== "staged"
      && candidate.phase !== "ownership-committed")
    || typeof candidate.operationId !== "string"
    || !UUID_PATTERN.test(candidate.operationId)
    || typeof candidate.originalName !== "string"
    || basename(candidate.originalName) !== candidate.originalName
    || candidate.originalName.length === 0
    || candidate.originalName === "."
    || candidate.originalName === ".."
    || typeof candidate.stableName !== "string"
    || !validIdentity(candidate.original)
    || !validIdentity(candidate.candidate)
    || typeof candidate.candidateArtifactDigest !== "string"
    || !DIGEST_PATTERN.test(candidate.candidateArtifactDigest)
    || typeof candidate.candidateExecutableIdentityDigest !== "string"
    || !DIGEST_PATTERN.test(candidate.candidateExecutableIdentityDigest)
    || typeof candidate.checksum !== "string"
    || !DIGEST_PATTERN.test(candidate.checksum)
  ) return false;
  const journal = candidate as AppImageHandoffJournal;
  return appImageHandoffJournalChecksum(journal) === journal.checksum;
}

export function parseAppImageUpdateJournal(
  value: unknown,
  channel: InertiaReleaseChannel,
  stableName: string,
): AppImageUpdateJournal {
  if (validHandoffJournal(value)) {
    if (value.channel !== channel || value.stableName !== stableName) {
      throw new Error("The AppImage update recovery journal is invalid.");
    }
    return value;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The AppImage update recovery journal is invalid.");
  }
  const candidate = value as {
    schema?: unknown;
    channel?: unknown;
    phase?: unknown;
    originalName?: unknown;
    stableName?: unknown;
    original?: unknown;
    candidate?: unknown;
  };
  const keys = Object.keys(value).sort().join("\0");
  const expectedKeys = candidate.phase === "prepared"
    ? "candidate\0channel\0original\0originalName\0phase\0schema\0stableName"
    : "channel\0original\0originalName\0phase\0schema\0stableName";
  if (
    keys !== expectedKeys
    || candidate.schema !== APPIMAGE_UPDATE_JOURNAL_SCHEMA
    || candidate.channel !== channel
    || (candidate.phase !== "preparing" && candidate.phase !== "prepared")
    || typeof candidate.originalName !== "string"
    || basename(candidate.originalName) !== candidate.originalName
    || candidate.originalName.length === 0
    || candidate.originalName === "."
    || candidate.originalName === ".."
    || candidate.stableName !== stableName
    || !validIdentity(candidate.original)
    || (candidate.phase === "prepared" && !validIdentity(candidate.candidate))
  ) {
    throw new Error("The AppImage update recovery journal is invalid.");
  }
  return candidate as AppImageUpdateJournal;
}
