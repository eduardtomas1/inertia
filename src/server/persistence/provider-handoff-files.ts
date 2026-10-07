import type Database from "better-sqlite3";

import type { ContinuationHistoryBlock } from "./continuation-history";
import { byteLength } from "./bounded-message-text";
import { parseTurnGitArtifactFiles } from "./git-artifact-codecs";

export const PROVIDER_HANDOFF_FILES_LABEL = "Files changed earlier in this chat";
export const MAX_PROVIDER_HANDOFF_FILES = 200;
export const MAX_PROVIDER_HANDOFF_FILES_BYTES = 8 * 1_024;

const MAX_PROVIDER_HANDOFF_ARTIFACTS = 100;
// Room for the block's label, reference, and JSON framing in the prompt.
const PROVIDER_HANDOFF_BLOCK_OVERHEAD_BYTES = 512;
const PROVIDER_HANDOFF_FILES_ABOUT =
  "Files this chat's earlier turns changed, from the local Git records; paths only, no contents.";

interface ProviderHandoffFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

function filesContent(files: ProviderHandoffFile[], omittedFileCount: number): string {
  return JSON.stringify({
    kind: "inertia-provider-handoff-files",
    about: PROVIDER_HANDOFF_FILES_ABOUT,
    files,
    omittedFileCount,
  });
}

/**
 * Newest status wins, except that a file added earlier stays added unless a
 * later turn deleted it. Line counts add up across every recorded turn.
 */
function changedFilesNewestFirst(
  database: Database.Database,
  conversationId: string,
): ProviderHandoffFile[] {
  const rows = database.prepare(`
    SELECT artifact.files_json FROM turn_git_artifacts AS artifact
    JOIN agent_turns AS turn ON turn.id = artifact.turn_id
    WHERE artifact.conversation_id = ?
      AND turn.association = 'authoritative'
      AND artifact.status IN ('ready', 'partial')
    ORDER BY artifact.created_at DESC, artifact.id DESC
    LIMIT ?
  `).all(conversationId, MAX_PROVIDER_HANDOFF_ARTIFACTS) as Array<{ files_json: string }>;
  const files = new Map<string, ProviderHandoffFile>();
  const deletedLater = new Set<string>();
  for (const row of rows) {
    for (const file of parseTurnGitArtifactFiles(row.files_json)) {
      const seen = files.get(file.path);
      if (seen) {
        seen.insertions += file.insertions;
        seen.deletions += file.deletions;
        if (file.status === "added" && !deletedLater.has(file.path)) seen.status = "added";
      } else {
        files.set(file.path, {
          path: file.path,
          status: file.status,
          insertions: file.insertions,
          deletions: file.deletions,
        });
      }
      if (file.status === "deleted") deletedLater.add(file.path);
    }
  }
  return [...files.values()];
}

/**
 * Lists the paths this chat changed so a provider handoff carries the
 * workspace story without file contents. Null when nothing was recorded.
 */
export function providerHandoffFilesBlock(
  database: Database.Database,
  conversationId: string,
): ContinuationHistoryBlock | null {
  const files = changedFilesNewestFirst(database, conversationId);
  if (files.length === 0) return null;
  const included: ProviderHandoffFile[] = [];
  let bytes = byteLength(filesContent([], files.length));
  for (const file of files.slice(0, MAX_PROVIDER_HANDOFF_FILES)) {
    const entryBytes = byteLength(JSON.stringify(file)) + 1;
    if (bytes + entryBytes > MAX_PROVIDER_HANDOFF_FILES_BYTES) break;
    included.push(file);
    bytes += entryBytes;
  }
  if (included.length === 0) return null;
  return {
    label: PROVIDER_HANDOFF_FILES_LABEL,
    content: filesContent(included, files.length - included.length),
    optional: true,
  };
}

/** Prompt bytes to reserve so the block fits beside the restored messages. */
export function providerHandoffBlockBytes(block: ContinuationHistoryBlock): number {
  return byteLength(JSON.stringify(block.content))
    + byteLength(block.label)
    + PROVIDER_HANDOFF_BLOCK_OVERHEAD_BYTES;
}
