import type { WebContents } from "electron";

import {
  MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS,
  MAX_PREVIEW_AGENT_DIALOGS,
  PREVIEW_AGENT_DIALOG_ANSWER_EVENT,
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

export async function armAgentPageDialogs(
  contents: WebContents,
  answer: PreviewAgentDialogAnswer,
): Promise<void> {
  await execute(contents, `(() => {
    dispatchEvent(new CustomEvent(${JSON.stringify(PREVIEW_AGENT_DIALOG_ANSWER_EVENT)}, { detail: ${JSON.stringify(answer)} }));
    return true;
  })()`);
}

export function takeAgentPageUnloadPrompts(contents: WebContents): PreviewAgentDialog[] {
  const unloads = unloadRecords.get(contents) ?? [];
  unloadRecords.delete(contents);
  return unloads;
}

export async function takeAgentPageDialogs(contents: WebContents): Promise<PreviewAgentDialog[]> {
  const unloads = takeAgentPageUnloadPrompts(contents);
  const value = await execute(contents, `(() => {
    const dialogs = globalThis.__inertiaAgentDialogs;
    const state = globalThis.__inertiaAgentBrowser;
    if (!dialogs || !Array.isArray(dialogs.records) || dialogs.records.length === 0) return [];
    const records = dialogs.records.splice(0, ${MAX_PREVIEW_AGENT_DIALOGS});
    if (state?.privacyGuardInstalled !== true) {
      return records.map((record) => ({ kind: record.kind, message: "", answer: record.answer }));
    }
    const privacy = ${PRIVACY_RUNTIME};
    return records.map((record) => ({
      kind: record.kind,
      message: privacy.redact(state, record.message, ${MAX_PREVIEW_AGENT_DIALOG_MESSAGE_CHARS}, record.truncated === true),
      answer: record.answer,
    }));
  })()`);
  const page = Array.isArray(value)
    ? value.slice(0, MAX_PREVIEW_AGENT_DIALOGS).map(dialog).filter((entry): entry is PreviewAgentDialog => entry !== null)
    : [];
  return [...unloads, ...page].slice(0, MAX_PREVIEW_AGENT_DIALOGS);
}

export function agentDialogDetail(dialogs: readonly PreviewAgentDialog[]): Record<string, unknown> {
  if (dialogs.length === 0) return {};
  const reported: PreviewAgentDialog[] = [];
  for (const entry of dialogs) {
    if (Buffer.byteLength(JSON.stringify([...reported, entry]), "utf8") > MAX_DIALOG_REPORT_BYTES) break;
    reported.push(entry);
  }
  return {
    dialogs: reported,
    ...(reported.length < dialogs.length ? { dialogsOmitted: dialogs.length - reported.length } : {}),
  };
}
