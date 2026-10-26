import type { Conversation, TurnGitArtifact } from "../../../shared/contracts";
import {
  DUO_COMPARISON_BRIEF_TITLE_MAX_CHARS,
  type DuoComparisonBrief,
  type DuoComparisonBriefSide,
} from "../../../shared/duo-comparison-brief";
import { isAgentTurnTerminalStatus } from "../../../shared/turn-lifecycle";
import type { RuntimeStore } from "../../database";
import { buildDuoComparisonPrompt, type DuoComparisonPromptStore } from "./duo-comparison";

function recordedFileCount(artifact: TurnGitArtifact | null): number | null {
  if (!artifact || artifact.absenceReason === "not-repository") return null;
  if (artifact.status !== "ready" || artifact.completeness !== "complete") return null;
  return artifact.files.length;
}

function knownConversation(store: DuoComparisonPromptStore, conversationId: string): Conversation | null {
  try {
    return store.conversation(conversationId);
  } catch {
    return null;
  }
}

function briefSide(
  store: DuoComparisonPromptStore,
  conversationId: string,
  turnId: string,
): DuoComparisonBriefSide | null {
  const turn = store.agentTurn(turnId);
  if (!isAgentTurnTerminalStatus(turn.status)) return null;
  const conversation = knownConversation(store, conversationId);
  return {
    conversationId,
    providerId: conversation?.providerId ?? null,
    title: (conversation?.title ?? "").trim().slice(0, DUO_COMPARISON_BRIEF_TITLE_MAX_CHARS),
    status: turn.status,
    filesChanged: recordedFileCount(store.turnGitArtifact(turnId)),
  };
}

export function buildDuoComparisonBrief(
  store: DuoComparisonPromptStore,
  launch: ReturnType<RuntimeStore["pairedLaunch"]>,
): DuoComparisonBrief | undefined {
  const [first, second] = launch.sides;
  if (!first.conversationId || !first.turnId || !second.conversationId || !second.turnId) return undefined;
  try {
    const a = briefSide(store, first.conversationId, first.turnId);
    const b = briefSide(store, second.conversationId, second.turnId);
    return a && b ? { launchId: launch.launchId, sides: [a, b] } : undefined;
  } catch {
    return undefined;
  }
}

export function buildDuoComparisonInput(
  store: DuoComparisonPromptStore,
  launch: ReturnType<RuntimeStore["pairedLaunch"]>,
): { prompt: string; brief: DuoComparisonBrief | undefined } {
  return {
    prompt: buildDuoComparisonPrompt(store, launch),
    brief: buildDuoComparisonBrief(store, launch),
  };
}
