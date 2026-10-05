import type { WebContents } from "electron";

import {
  MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS,
  MAX_PREVIEW_AGENT_DIALOGS,
  PREVIEW_AGENT_DIALOG_ANSWER_EVENT,
  armPreviewAgentDialogAnswer,
  takePreviewAgentDialogRecords,
  type PreviewAgentDialog,
  type PreviewAgentDialogAnswer,
} from "../shared/preview-agent-dialogs.js";
import { agentPageIsFrozen, evaluateInFrozenAgentPage } from "./preview-agent-boundary.js";
import { AGENT_BROWSER_WORLD_ID, PRIVACY_RUNTIME } from "./preview-agent-page.js";

const MAX_DIALOG_REPORT_BYTES = 8 * 1_024;
const unloadRecords = new WeakMap<WebContents, PreviewAgentDialog[]>();

async function execute(contents: WebContents, code: string): Promise<unknown> {
  if (agentPageIsFrozen(contents)) return await evaluateInFrozenAgentPage(contents, code);
  return await contents.executeJavaScriptInIsolatedWorld(AGENT_BROWSER_WORLD_ID, [{ code }], true);
}

function dialog(value: unknown): PreviewAgentDialog | null {
  if (typeof value !== "object" || value === null) return null;
  const { kind, message, answer } = value as Record<string, unknown>;
  return (kind === "alert" || kind === "confirm" || kind === "prompt" || kind === "beforeunload")
    && typeof message === "string" && message.length <= MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS
    && (answer === "accept" || answer === "dismiss")
    ? { kind, message, answer }
    : null;
}

export function recordAgentPageUnloadPrompt(contents: WebContents): void {
  const records = unloadRecords.get(contents) ?? [];
  if (records.length >= MAX_PREVIEW_AGENT_DIALOGS) return;
  records.push({ kind: "beforeunload", message: "", answer: "accept" });
  unloadRecords.set(contents, records);
}

export interface AgentPageDialogReport {
  dialogs: PreviewAgentDialog[];
  omitted: number;
  withheld: boolean;
}

export async function armAgentPageDialogs(
  contents: WebContents,
  answer: PreviewAgentDialogAnswer,
): Promise<void> {
  await execute(contents, `(${armPreviewAgentDialogAnswer.toString()})(${
    JSON.stringify(PREVIEW_AGENT_DIALOG_ANSWER_EVENT)}, ${JSON.stringify(answer)})`);
}

export function takeAgentPageUnloadPrompts(contents: WebContents): AgentPageDialogReport {
  const unloads = unloadRecords.get(contents) ?? [];
  unloadRecords.delete(contents);
  return { dialogs: unloads, omitted: 0, withheld: false };
}

export async function takeAgentPageDialogs(contents: WebContents): Promise<AgentPageDialogReport> {
  const unloads = takeAgentPageUnloadPrompts(contents).dialogs;
  const value = await execute(contents, `(() => {
    const taken = (${takePreviewAgentDialogRecords.toString()})(${MAX_PREVIEW_AGENT_DIALOGS});
    const state = globalThis.__inertiaAgentBrowser;
    if (taken.records.length === 0) return { records: [], omitted: taken.omitted, withheld: false };
    if (state?.privacyGuardInstalled !== true || state.evidenceWithheld) {
      return {
        records: taken.records.map((record) => ({ kind: record.kind, message: "", answer: record.answer })),
        omitted: taken.omitted,
        withheld: true,
      };
    }
    const privacy = ${PRIVACY_RUNTIME};
    return {
      records: taken.records.map((record) => ({
        kind: record.kind,
        message: privacy.redact(state, record.message, ${MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS}, record.truncated === true),
        answer: record.answer,
      })),
      omitted: taken.omitted,
      withheld: false,
    };
  })()`);
  const report = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const page = Array.isArray(report.records)
    ? report.records.slice(0, MAX_PREVIEW_AGENT_DIALOGS).map(dialog).filter((entry): entry is PreviewAgentDialog => entry !== null)
    : [];
  const omitted = typeof report.omitted === "number" && Number.isSafeInteger(report.omitted) && report.omitted > 0
    ? report.omitted
    : 0;
  const dialogs = [...unloads, ...page];
  return {
    dialogs: dialogs.slice(0, MAX_PREVIEW_AGENT_DIALOGS),
    omitted: omitted + Math.max(0, dialogs.length - MAX_PREVIEW_AGENT_DIALOGS),
    withheld: report.withheld === true,
  };
}

export function agentDialogDetail(report: AgentPageDialogReport): Record<string, unknown> {
  if (report.dialogs.length === 0 && report.omitted === 0) return {};
  const reported: PreviewAgentDialog[] = [];
  for (const entry of report.dialogs) {
    if (Buffer.byteLength(JSON.stringify([...reported, entry]), "utf8") > MAX_DIALOG_REPORT_BYTES) break;
    reported.push(entry);
  }
  const omitted = report.omitted + report.dialogs.length - reported.length;
  return {
    dialogs: reported,
    ...(omitted > 0 ? { dialogsOmitted: omitted } : {}),
    ...(report.withheld ? { dialogsWithheld: true } : {}),
  };
}
