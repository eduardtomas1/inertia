import type { DiffFile, DiffHunk, DiffLine, StructuredDiff } from "./contracts";

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cleanPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/dev/null") return trimmed;
  let decoded = trimmed;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { decoded = JSON.parse(trimmed) as string; } catch { decoded = trimmed.slice(1, -1); }
  }
  return decoded.replace(/^[ab]\//u, "");
}

function diffHeaderPaths(line: string): [string, string] | null {
  if (!line.startsWith("diff --git ")) return null;
  const tokens = line.slice("diff --git ".length).match(/"(?:\\.|[^"\\])*"|\S+/gu);
  if (!tokens || tokens.length < 2) return null;
  return [cleanPath(tokens[0]), cleanPath(tokens[1])];
}

function lineKind(prefix: string): DiffLine["kind"] {
  if (prefix === "+") return "addition";
  if (prefix === "-") return "deletion";
  if (prefix === " ") return "context";
  return "meta";
}

export function parseUnifiedDiff(patch: string): StructuredDiff {
  const fingerprint = stableHash(patch);
  if (!patch.trim()) return { fingerprint, files: [] };

  const files: DiffFile[] = [];
  const lines = patch.replace(/\r\n/gu, "\n").split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const rawLine of lines) {
    const headerPaths = diffHeaderPaths(rawLine);
    if (headerPaths) {
      file = {
        path: headerPaths[1] || headerPaths[0] || "unknown",
        oldPath: headerPaths[0] || "unknown",
        newPath: headerPaths[1] || "unknown",
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }

    if (!file) continue;
    if (rawLine.startsWith("--- ")) {
      file.oldPath = cleanPath(rawLine.slice(4));
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      file.newPath = cleanPath(rawLine.slice(4));
      file.path = file.newPath === "/dev/null" ? file.oldPath : file.newPath;
      continue;
    }

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(rawLine);
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1]);
      const oldCount = Number(hunkMatch[2] ?? "1");
      const newStart = Number(hunkMatch[3]);
      const newCount = Number(hunkMatch[4] ?? "1");
      const sequence = file.hunks.length;
      const id = `hunk-${stableHash(`${file.path}\n${sequence}\n${rawLine}`)}`;
      hunk = {
        id,
        header: rawLine,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      file.hunks.push(hunk);
      oldCursor = oldStart;
      newCursor = newStart;
      continue;
    }

    if (!hunk || rawLine === "") continue;
    const prefix = rawLine.charAt(0);
    const kind = lineKind(prefix);
    const index = hunk.lines.length;
    const line: DiffLine = {
      id: `${hunk.id}:line-${index}`,
      kind,
      content: kind === "meta" ? rawLine : rawLine.slice(1),
      patchLine: rawLine,
      oldLineNumber: kind === "addition" || kind === "meta" ? null : oldCursor,
      newLineNumber: kind === "deletion" || kind === "meta" ? null : newCursor,
      newInsertionIndex: newCursor - 1,
    };
    hunk.lines.push(line);
    if (kind === "context") { oldCursor += 1; newCursor += 1; }
    if (kind === "addition") newCursor += 1;
    if (kind === "deletion") oldCursor += 1;
  }

  return { fingerprint, files };
}

export function selectedDiffReference(file: DiffFile, hunk: DiffHunk, lineIds: readonly string[]): string {
  const selected = new Set(lineIds);
  const lines = hunk.lines.filter((line) => selected.has(line.id));
  const numbered = lines.map((line) => {
    const number = line.newLineNumber ?? line.oldLineNumber;
    return `${line.patchLine.charAt(0)}${number ?? "?"}: ${line.content}`;
  });
  return [
    `Diff selection in ${file.path}`,
    hunk.header,
    ...numbered,
  ].join("\n");
}
