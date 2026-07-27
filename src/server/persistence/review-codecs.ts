import type {
  DiffReviewNote,
  DiffReviewState,
  DiffReviewSummary,
} from "../../shared/contracts";
import {
  parsePersistedReviewSummaryJson,
  upgradeLegacyPersistedReviewSummary,
} from "../review-summary";
import type {
  DiffReviewNoteRow,
  DiffReviewStateRow,
  DiffReviewSummaryRow,
} from "./rows";

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let malformedReviewSummaryWarningEmitted = false;

function flagMalformedReviewSummary(): null {
  if (!malformedReviewSummaryWarningEmitted) {
    malformedReviewSummaryWarningEmitted = true;
    console.warn(
      "A malformed persisted review summary was omitted from the runtime snapshot.",
    );
  }
  return null;
}

export function reviewSummaryFromRow(
  row: DiffReviewSummaryRow,
): DiffReviewSummary | null {
  if (row.summary_json !== null) {
    const summary = parsePersistedReviewSummaryJson(row.summary_json);
    if (
      !summary
      || summary.conversationId !== row.conversation_id
      || summary.fingerprint !== row.fingerprint
      || summary.providerId !== row.provider_id
      || summary.overall !== row.overall
      || summary.generatedAt !== row.generated_at
    ) {
      return flagMalformedReviewSummary();
    }
    return summary;
  }

  let files: unknown;
  try {
    files = JSON.parse(row.files_json) as unknown;
  } catch {
    return flagMalformedReviewSummary();
  }
  return upgradeLegacyPersistedReviewSummary({
    conversationId: row.conversation_id,
    fingerprint: row.fingerprint,
    providerId: row.provider_id,
    overall: row.overall,
    files,
    generatedAt: row.generated_at,
  }) ?? flagMalformedReviewSummary();
}

export function reviewStateFromRow(row: DiffReviewStateRow): DiffReviewState {
  return {
    conversationId: row.conversation_id,
    scope: row.scope,
    path: row.path,
    hunkId: row.hunk_id || null,
    targetFingerprint: row.target_fingerprint,
    reviewed: row.reviewed === 1,
    stale: row.stale === 1,
    updatedAt: row.updated_at,
  };
}

export function reviewNoteFromRow(row: DiffReviewNoteRow): DiffReviewNote {
  const parsed = parseJsonArray(row.line_ids_json)
    .filter((value): value is string => typeof value === "string")
    .slice(0, 500);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    path: row.path,
    hunkId: row.hunk_id || null,
    lineIds: parsed,
    targetFingerprint: row.target_fingerprint,
    body: row.body,
    stale: row.stale === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
