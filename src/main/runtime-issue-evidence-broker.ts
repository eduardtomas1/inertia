import { ISSUE_DIAGNOSTICS_MAX_BYTES, ISSUE_OS_VERSION_PATTERN, type IssueHostEvidence } from "../node/runtime-issue-evidence-protocol.js";
import { exportDiagnosticsForReport } from "./diagnostic-export.js";
import type { RuntimeIssueEvidenceBroker } from "./runtime-issue-evidence-coordinator.js";

const DIAGNOSTICS_WINDOW_MS = 24 * 60 * 60 * 1_000;

interface Options {
  channel: IssueHostEvidence["channel"];
  now?: () => number;
  systemVersion?: () => string;
  exportDiagnostics?: typeof exportDiagnosticsForReport;
}

function boundedDiagnostics(text: string): string {
  const value = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim();
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    bytes += Buffer.byteLength(character);
    if (bytes > ISSUE_DIAGNOSTICS_MAX_BYTES) break;
    end += character.length;
  }
  return value.slice(0, end);
}

export function runtimeIssueEvidenceBroker(options: Options): RuntimeIssueEvidenceBroker {
  const now = options.now ?? Date.now;
  const systemVersion = options.systemVersion ?? (() => process.getSystemVersion());
  const exportDiagnostics = options.exportDiagnostics ?? exportDiagnosticsForReport;
  return {
    collect: async ({ attachDiagnostics }) => {
      let osVersion: string | null = null;
      try {
        const version = systemVersion().trim();
        osVersion = ISSUE_OS_VERSION_PATTERN.test(version) ? version : null;
      } catch { osVersion = null; }
      const diagnostics = attachDiagnostics
        ? boundedDiagnostics(await exportDiagnostics({ sinceMs: now() - DIAGNOSTICS_WINDOW_MS, maxBytes: ISSUE_DIAGNOSTICS_MAX_BYTES }))
        : "";
      return { channel: options.channel, osVersion, diagnostics };
    },
  };
}
