import type { DiffFile, DiffHunk, DiffLine, StructuredDiff } from "./contracts";

export const MAX_CHAT_MESSAGE_CHARS = 20_000;
export const MAX_DIFF_CONTEXT_CHARS = 16_000;
export const MAX_SAFE_DIFF_SELECTION_CHARS = 256_000;
export const MAX_DIFF_SELECTION_LINES = 500;
const MAX_CONTEXT_LINE_CHARS = 4_000;

function compactHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A small synchronous SHA-256 implementation keeps diff identities identical in
 * the browser and the local runtime. It hashes UTF-8 bytes, not UTF-16 code
 * units, so non-ASCII paths and source content are fingerprinted consistently.
 */
export function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  const rotate = (word: number, count: number) => (word >>> count) | (word << (32 - count));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const sigma0 = rotate(left, 7) ^ rotate(left, 18) ^ (left >>> 3);
      const sigma1 = rotate(right, 17) ^ rotate(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choice + constants[index]! + words[index]!) >>> 0;
      const sum0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d! + temporary1) >>> 0;
      d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
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
  const fingerprint = sha256(patch);
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
      const id = `hunk-${compactHash(`${file.path}\n${sequence}\n${rawLine}`)}`;
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
      oldInsertionIndex: oldCursor - 1,
    };
    hunk.lines.push(line);
    if (kind === "meta" && rawLine === "\\ No newline at end of file") {
      const previous = hunk.lines.at(-2);
      if (previous) previous.noFinalNewline = true;
    }
    if (kind === "context") { oldCursor += 1; newCursor += 1; }
    if (kind === "addition") newCursor += 1;
    if (kind === "deletion") oldCursor += 1;
  }

  return { fingerprint, files };
}

export interface DiffContextOptions {
  purpose?: "ask" | "revision" | "prompt";
  instruction?: string;
  maxChars?: number;
}

export interface DiffContext {
  text: string;
  selectedLineCount: number;
  includedLineCount: number;
  truncated: boolean;
}

export class DiffContextError extends Error {}

export function diffHunkFingerprint(file: DiffFile, hunk: DiffHunk): string {
  return sha256(JSON.stringify({
    path: file.path,
    header: hunk.header,
    lines: hunk.lines.map((line) => ({
      kind: line.kind,
      content: line.content,
      oldLineNumber: line.oldLineNumber,
      newLineNumber: line.newLineNumber,
      noFinalNewline: line.noFinalNewline ?? false,
    })),
  }));
}

export function diffFileFingerprint(file: DiffFile): string {
  return sha256(JSON.stringify({
    path: file.path,
    oldPath: file.oldPath,
    newPath: file.newPath,
    hunks: file.hunks.map((hunk) => diffHunkFingerprint(file, hunk)),
  }));
}

function boundedLine(line: DiffLine): { text: string; truncated: boolean } {
  const number = line.newLineNumber ?? line.oldLineNumber;
  const prefix = line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " ";
  const label = `${prefix}${number ?? "?"}: `;
  if (label.length + line.content.length <= MAX_CONTEXT_LINE_CHARS) {
    return { text: `${label}${line.content}`, truncated: false };
  }
  const available = Math.max(80, MAX_CONTEXT_LINE_CHARS - label.length - 48);
  const leading = Math.ceil(available * 0.7);
  const trailing = available - leading;
  return {
    text: `${label}${line.content.slice(0, leading)} … [long line truncated] … ${line.content.slice(-trailing)}`,
    truncated: true,
  };
}

function reviewPreamble(purpose: NonNullable<DiffContextOptions["purpose"]>, instruction: string): string[] {
  if (purpose === "ask") {
    return [
      "Read-only diff question. Explain the selected scope without modifying files or requesting write access.",
      `Question: ${instruction || "Explain what this selected code does, why it changed, and any risks I should know about."}`,
    ];
  }
  if (purpose === "revision") {
    return [
      "Requested revision scope. A recovery checkpoint was created before this turn.",
      "The selected lines are the requested focus, not a perfect technical write fence. Avoid unrelated files and hunks, and report any necessary spillover.",
      `Instruction: ${instruction || "Review this selection and improve it while preserving the surrounding behavior."}`,
    ];
  }
  return instruction ? [`Local review context: ${instruction}`] : ["Local review context."];
}

/**
 * Builds the only prompt representation used for a selected diff. It applies
 * the renderer's real 20,000-character message ceiling, makes all truncation
 * visible, and rejects inputs so large that a bounded excerpt would be
 * misleading.
 */
export function buildDiffContext(
  file: DiffFile,
  hunk: DiffHunk,
  lineIds: readonly string[],
  options: DiffContextOptions = {},
): DiffContext {
  const maxChars = Math.min(
    MAX_CHAT_MESSAGE_CHARS,
    Math.max(1_000, options.maxChars ?? MAX_DIFF_CONTEXT_CHARS),
  );
  const uniqueIds = new Set(lineIds);
  if (uniqueIds.size !== lineIds.length) throw new DiffContextError("The diff selection contains duplicated line identities.");
  if (lineIds.length === 0) throw new DiffContextError("Select at least one diff line.");
  if (lineIds.length > MAX_DIFF_SELECTION_LINES) {
    throw new DiffContextError(`Select at most ${MAX_DIFF_SELECTION_LINES} lines at a time.`);
  }
  const selected = new Set(lineIds);
  const lines = hunk.lines.filter((line) => selected.has(line.id));
  if (lines.length !== lineIds.length) throw new DiffContextError("The selected lines no longer belong to this hunk. Refresh the diff.");
  const rawChars = lines.reduce((total, line) => total + line.content.length + 16, 0);
  if (rawChars > MAX_SAFE_DIFF_SELECTION_CHARS) {
    throw new DiffContextError("This selection is too large to represent safely. Select a smaller, focused range.");
  }

  const purpose = options.purpose ?? "prompt";
  const instruction = options.instruction?.trim().slice(0, 2_000) ?? "";
  const header = [
    ...reviewPreamble(purpose, instruction),
    "",
    `Target file: ${file.path}`,
    `Target hunk: ${hunk.header}`,
    `Selected lines: ${lines.length}`,
    "```diff",
  ];
  const footer = ["```"];
  const output = [...header];
  let used = `${header.join("\n")}\n${footer.join("\n")}`.length;
  let includedLineCount = 0;
  let truncated = false;
  for (const line of lines) {
    const bounded = boundedLine(line);
    if (used + bounded.text.length + 1 > maxChars - 96) {
      truncated = true;
      break;
    }
    output.push(bounded.text);
    includedLineCount += 1;
    used += bounded.text.length + 1;
    truncated ||= bounded.truncated;
  }
  if (includedLineCount < lines.length) truncated = true;
  output.push(...footer);
  if (truncated) {
    output.push(`[Selection excerpt truncated: ${includedLineCount} of ${lines.length} lines included; long lines may be shortened.]`);
  }
  const text = output.join("\n");
  if (text.length > maxChars || text.length > MAX_CHAT_MESSAGE_CHARS) {
    throw new DiffContextError("The selected diff cannot fit within the message limit. Select a smaller range.");
  }
  return { text, selectedLineCount: lines.length, includedLineCount, truncated };
}

export function selectedDiffReference(file: DiffFile, hunk: DiffHunk, lineIds: readonly string[]): string {
  return buildDiffContext(file, hunk, lineIds, { purpose: "prompt" }).text;
}

export function selectedLineFingerprint(file: DiffFile, hunk: DiffHunk, lineIds: readonly string[]): string {
  const selected = new Set(lineIds);
  const lines = hunk.lines.filter((line) => selected.has(line.id));
  return sha256(JSON.stringify({
    path: file.path,
    hunkHeader: hunk.header,
    lines: lines.map((line) => ({
      kind: line.kind,
      content: line.content,
      oldLineNumber: line.oldLineNumber,
      newLineNumber: line.newLineNumber,
    })),
  }));
}
