import { constants as fsConstants } from "node:fs";
import {
  realpath,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";

import {
  DEFAULT_DIFF_BYTES,
  DEFAULT_DIFF_FILES,
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
} from "./constants";
import {
  isContained,
  repositoryRoot,
  validatedPaths,
} from "./paths";
import {
  boundedInteger,
  runGit,
  utf8Prefix,
} from "./runner";
import {
  getRepositoryStatus,
  hasHead,
} from "./status";
import type {
  GitDiffOptions,
  GitUnifiedDiff,
} from "./types";

async function untrackedPreview(
  root: string,
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const absolute = resolve(root, path);
  if (!isContained(root, absolute)) return { text: "", truncated: false };
  try {
    const canonical = await realpath(absolute);
    if (!isContained(root, canonical)) return { text: "", truncated: false };
    const info = await stat(canonical);
    if (!info.isFile()) return { text: "", truncated: false };
    const file = await import("node:fs/promises")
      .then(({ open }) => open(canonical, fsConstants.O_RDONLY));
    try {
      const bytes = Math.min(info.size, maxBytes + 1);
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await file.read(buffer, 0, bytes, 0);
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) {
        return {
          text: `Binary file ${path} is untracked.\n`,
          truncated: false,
        };
      }
      const decoded = new TextDecoder("utf-8", { fatal: true })
        .decode(content.subarray(0, maxBytes));
      const sourceLines = decoded.endsWith("\n")
        ? decoded.slice(0, -1).split("\n")
        : decoded.split("\n");
      const lines = sourceLines.map((line) => `+${line}`).join("\n");
      return {
        text: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${sourceLines.length} @@\n${lines}\n`,
        truncated: info.size > maxBytes,
      };
    } finally {
      await file.close();
    }
  } catch {
    return {
      text: `Unable to preview untracked file ${path}.\n`,
      truncated: false,
    };
  }
}

export async function getUnifiedDiff(
  repositoryPath: string,
  options: GitDiffOptions = {},
): Promise<GitUnifiedDiff> {
  const root = await repositoryRoot(repositoryPath);
  const maxFiles = boundedInteger(
    options.maxFiles,
    DEFAULT_DIFF_FILES,
    MAX_DIFF_FILES,
  );
  const maxBytes = boundedInteger(
    options.maxBytes,
    DEFAULT_DIFF_BYTES,
    MAX_DIFF_BYTES,
  );
  const status = await getRepositoryStatus(root);
  const requested = options.paths
    ? await validatedPaths(root, options.paths)
    : null;
  const requestedSet = requested ? new Set(requested) : null;
  const candidates = status.files.filter(
    (file) => !requestedSet || requestedSet.has(file.path),
  );
  const selected = candidates.slice(0, maxFiles);
  const tracked = selected
    .filter((file) => file.status !== "untracked")
    .flatMap((file) =>
      file.previousPath ? [file.previousPath, file.path] : [file.path]);
  let text = "";
  let truncated = candidates.length > selected.length;

  if (tracked.length > 0) {
    const baseArgs = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      ...(options.ignoreWhitespace ? ["--ignore-all-space"] : []),
    ];
    const args = (await hasHead(root))
      ? [...baseArgs, "HEAD", "--", ...tracked]
      : [...baseArgs, "--cached", "--", ...tracked];
    const result = await runGit(root, args, {
      maxOutputBytes: maxBytes,
      truncateOutput: true,
      failureMessage: "Unable to generate the repository diff.",
    });
    text = utf8Prefix(result.stdout, maxBytes);
    truncated ||= result.truncated;
  }

  for (const file of selected) {
    if (file.status !== "untracked") continue;
    const remaining = maxBytes - Buffer.byteLength(text);
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const preview = await untrackedPreview(root, file.path, remaining);
    const previewBuffer = Buffer.from(preview.text);
    text += utf8Prefix(previewBuffer, remaining);
    truncated ||= preview.truncated || previewBuffer.length > remaining;
  }
  return {
    text,
    filesIncluded: selected.length,
    totalFiles: candidates.length,
    truncated,
  };
}
