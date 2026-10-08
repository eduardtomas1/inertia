import type Database from "better-sqlite3";

import { continuationRouteTurnSql, type ContinuationRouteFilter } from "./conversation-context-source";
import { byteLength } from "./bounded-message-text";
import { parseTurnGitArtifactFiles } from "./git-artifact-codecs";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";

export const PROVIDER_HANDOFF_FILES_LABEL = "Files changed earlier in this chat";
export const MAX_PROVIDER_HANDOFF_FILES = 200;
export const MAX_PROVIDER_HANDOFF_FILES_BYTES = 8 * 1_024;

const MAX_PROVIDER_HANDOFF_ARTIFACTS = 100;
// Room for the block's label, reference, and JSON framing in the prompt.
const PROVIDER_HANDOFF_BLOCK_OVERHEAD_BYTES = 512;
const FILE_STATUS_LETTERS: Readonly<Record<string, string>> = {
  added: "A",
  untracked: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
};

interface ProviderHandoffBlock {
  label: string;
  content: string;
  optional?: true;
  structured?: true;
}

interface ProviderHandoffFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
}

export interface ChangedFileLines {
  files: string[];
  omittedFiles?: number;
}
/**
 * Newest status wins, except that a file added earlier stays added unless a
 * later turn deleted it. Line counts add up across every recorded turn.
 */
function changedFilesNewestFirst(
  database: Database.Database,
  conversationId: string,
  route: ContinuationRouteFilter | null,
): ProviderHandoffFile[] {
  const routed = route ? continuationRouteTurnSql("turn", route) : { sql: "1", parameters: [] };
  const rows = database.prepare(`
    SELECT artifact.files_json FROM turn_git_artifacts AS artifact
    JOIN agent_turns AS turn ON turn.id = artifact.turn_id
    WHERE artifact.conversation_id = ?
      AND turn.association = 'authoritative'
      AND artifact.status IN ('ready', 'partial')
      AND ${routed.sql}
    ORDER BY artifact.created_at DESC, artifact.id DESC
    LIMIT ?
  `).all(conversationId, ...routed.parameters, MAX_PROVIDER_HANDOFF_ARTIFACTS) as Array<{ files_json: string }>;
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

function fileLine({ path, status, insertions, deletions }: ProviderHandoffFile): string {
  return neutralizeUntrustedAgentText(
    `${FILE_STATUS_LETTERS[status] ?? "?"} ${path} +${insertions} -${deletions}`,
  );
}

export function changedFileLines(
  database: Database.Database,
  conversationId: string,
  route: ContinuationRouteFilter | null,
  maximumBytes: number,
): ChangedFileLines | null {
  const files = changedFilesNewestFirst(database, conversationId, route);
  const lines: string[] = [];
  let bytes = byteLength(JSON.stringify({ files: [], omittedFiles: files.length }));
  for (const file of files.slice(0, MAX_PROVIDER_HANDOFF_FILES)) {
    const line = fileLine(file);
    const lineBytes = byteLength(JSON.stringify(line)) + 1;
    if (bytes + lineBytes > maximumBytes) break;
    lines.push(line);
    bytes += lineBytes;
  }
  if (lines.length === 0) return null;
  return lines.length < files.length
    ? { files: lines, omittedFiles: files.length - lines.length }
    : { files: lines };
}

/**
 * Lists the paths this chat changed so a provider handoff carries the
 * workspace story without file contents. Only turns whose messages the route
 * may carry contribute. Null when nothing was recorded.
 */
export function providerHandoffFilesBlock(
  database: Database.Database,
  conversationId: string,
  route: ContinuationRouteFilter,
): ProviderHandoffBlock | null {
  const files = changedFileLines(database, conversationId, route, MAX_PROVIDER_HANDOFF_FILES_BYTES);
  return files
    ? { label: PROVIDER_HANDOFF_FILES_LABEL, content: JSON.stringify(files), optional: true, structured: true }
    : null;
}

export function contextBlockPromptBytes(block: { content: string; structured?: true }): number {
  return block.structured ? byteLength(block.content) : byteLength(JSON.stringify(block.content));
}

/** Prompt bytes the block needs in the room the restored messages leave. */
export function providerHandoffBlockBytes(block: ProviderHandoffBlock): number {
  return contextBlockPromptBytes(block)
    + byteLength(block.label)
    + PROVIDER_HANDOFF_BLOCK_OVERHEAD_BYTES;
}
