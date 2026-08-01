import {
  DEFAULT_DIFF_BYTES,
  DEFAULT_DIFF_FILES,
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
} from "./constants";
import { repositoryRoot, validatedPaths } from "./paths";
import {
  boundedInteger,
  runGitInspection,
  utf8Prefix,
} from "./runner";
import {
  getRepositoryStatus,
  hasHead,
} from "./status";
import {
  GitError,
  type GitDiffOptions,
  type GitUnifiedDiff,
} from "./types";
import type {
  RuntimeSecureFileBroker,
  SecureFileRootCapability,
} from "../secure-files";

export interface GitDiffTestHooks {
  afterUntrackedValidated?: (path: string) => void | Promise<void>;
}

async function untrackedPreview(
  path: string,
  maxBytes: number,
  testHooks?: GitDiffTestHooks,
  secureFiles?: RuntimeSecureFileBroker,
  secureRoot?: SecureFileRootCapability,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  try {
    if (!secureFiles || !secureRoot) {
      throw new Error("Secure repository file access is unavailable.");
    }
    await testHooks?.afterUntrackedValidated?.(path);
    const file = await secureFiles.read(
      secureRoot,
      path,
      maxBytes,
      signal,
    );
    const content = file.content;
    if (content.includes(0)) {
      return {
        text: `Binary file ${path} is untracked.\n`,
        truncated: false,
      };
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const sourceLines = decoded.endsWith("\n")
      ? decoded.slice(0, -1).split("\n")
      : decoded.split("\n");
    const lines = sourceLines.map((line) => `+${line}`).join("\n");
    return {
      text: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${sourceLines.length} @@\n${lines}\n`,
      truncated: false,
    };
  } catch {
    return {
      text: `Unable to preview untracked file ${path}.\n`,
      truncated: true,
    };
  }
}

export async function getUnifiedDiff(
  repositoryPath: string,
  options: GitDiffOptions = {},
  testHooks?: GitDiffTestHooks,
  secureFiles?: RuntimeSecureFileBroker,
  secureRoot?: SecureFileRootCapability,
): Promise<GitUnifiedDiff> {
  if (secureRoot && !secureFiles) {
    throw new Error("Secure repository file access is unavailable.");
  }
  if (options.signal?.aborted) {
    throw new GitError("timeout", "Git inspection took too long.");
  }
  if (secureRoot) {
    await secureFiles!.verifyRoot(secureRoot, options.signal);
  }
  const root = secureRoot?.root ?? await repositoryRoot(repositoryPath, {
    deadlineAt: options.deadlineAt,
  });
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
  const status = await getRepositoryStatus(root, {
    deadlineAt: options.deadlineAt,
  });
  const requested = options.paths
    ? await validatedPaths(root, options.paths)
    : null;
  const requestedSet = requested ? new Set(requested) : null;
  const candidates = status.files.filter(
    (file) => !requestedSet || requestedSet.has(file.path),
  );
  const selected = candidates.slice(0, maxFiles);
  const rootCapability = selected.some(({ status: fileStatus }) =>
    fileStatus === "untracked") && secureFiles
    ? secureRoot ?? await secureFiles.authorizeRoot(root, options.signal)
    : secureRoot;
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
    const args = (await hasHead(root, { deadlineAt: options.deadlineAt }))
      ? [...baseArgs, "HEAD", "--", ...tracked]
      : [...baseArgs, "--cached", "--", ...tracked];
    const result = await runGitInspection(root, args, {
      deadlineAt: options.deadlineAt,
      maxOutputBytes: maxBytes,
      truncateOutput: true,
      failureMessage: "Unable to generate the repository diff.",
    });
    text = utf8Prefix(result.stdout, maxBytes);
    truncated ||= result.truncated;
  }

  for (const file of selected) {
    if (file.status !== "untracked") continue;
    if (
      options.deadlineAt !== undefined
      && Date.now() >= options.deadlineAt
    ) {
      throw new GitError(
        "timeout",
        "Git took too long to complete the operation.",
      );
    }
    const remaining = maxBytes - Buffer.byteLength(text);
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const preview = await untrackedPreview(
      file.path,
      remaining,
      testHooks,
      secureFiles,
      rootCapability,
      options.signal,
    );
    const previewBuffer = Buffer.from(preview.text);
    text += utf8Prefix(previewBuffer, remaining);
    truncated ||= preview.truncated || previewBuffer.length > remaining;
  }
  if (secureRoot) {
    await secureFiles!.verifyRoot(secureRoot, options.signal);
  }
  return {
    text,
    filesIncluded: selected.length,
    totalFiles: candidates.length,
    truncated,
  };
}
