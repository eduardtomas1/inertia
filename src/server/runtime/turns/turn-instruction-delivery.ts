import { createHash } from "node:crypto";

import type { AgentTurn, Conversation } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import {
  MAX_SYSTEM_INSTRUCTION_BYTES,
  watcherHarnessProfile,
} from "../../provider/watcher-harness-profile";
import type { HiddenProviderInstruction } from "./request-context";

export function systemInstructionText(
  instructions: readonly HiddenProviderInstruction[],
): string | undefined {
  return instructions.length === 0
    ? undefined
    : instructions.map(({ label, text }) => `[${label}]\n${text}`).join("\n\n");
}

export function chatInstruction(conversationId: string): HiddenProviderInstruction {
  return { label: "inertia-chat", text: `This chat's id is ${conversationId}.` };
}

export class PromptInstructionDeliveries {
  private readonly sent = new Map<string, { turnId: string; digest: string }>();

  record(conversationId: string, turnId: string, digest: string): void {
    this.sent.set(conversationId, { turnId, digest });
  }

  sentTurnId(conversationId: string, digest: string): string | null {
    const delivery = this.sent.get(conversationId);
    return delivery?.digest === digest ? delivery.turnId : null;
  }
}

export interface HiddenInstructionDeliveryInput {
  store: RuntimeStore;
  deliveries?: PromptInstructionDeliveries;
  conversation: Conversation;
  harnessId: string;
  pack: readonly HiddenProviderInstruction[];
  resumedSessionId: string | null;
  latestTurn: AgentTurn | null;
  promptWithheld: boolean;
}

export interface HiddenInstructionDelivery {
  sessionInstruction?: string;
  sessionInstructionBytes?: number;
  promptPack: readonly HiddenProviderInstruction[];
  freshSessionPromptPack: readonly HiddenProviderInstruction[];
  buildModeDue: boolean;
  recordPromptPack(turnId: string): void;
}

export function resolveHiddenInstructionDelivery(
  input: HiddenInstructionDeliveryInput,
): HiddenInstructionDelivery {
  const { store, conversation, resumedSessionId } = input;
  const ledger = store.turnLedgerRepository;
  const nativeGoalSession = resumedSessionId !== null && store.agentGoals(conversation.id)
    .some((goal) => goal.source === "codex-native" && goal.providerSessionId === resumedSessionId);
  const settledOnSession = (turn: AgentTurn | null): boolean => turn !== null
    && turn.status === "completed"
    && turn.providerSessionAfter === resumedSessionId
    && !ledger.compactedSince(conversation.id, turn.requestedAt);
  const text = systemInstructionText(input.pack);
  const bytes = text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  const profile = watcherHarnessProfile(input.harnessId);
  const systemChannel = text !== undefined
    && profile.systemInstruction
    && bytes <= MAX_SYSTEM_INSTRUCTION_BYTES;
  const digest = text === undefined ? "" : createHash("sha256").update(text, "utf8").digest("hex");
  const sessionHoldsPack = (sessionId: string): boolean => systemChannel
    && (!profile.sessionScopedSystemInstruction
      || ledger.sessionInstructionBytes(conversation.id, sessionId) === bytes);
  const promptPackHeld = (): boolean => {
    const turnId = input.deliveries?.sentTurnId(conversation.id, digest) ?? null;
    if (turnId === null) return false;
    try {
      return settledOnSession(ledger.get(turnId));
    } catch {
      return false;
    }
  };
  const packDue = text !== undefined && (resumedSessionId === null
    ? !systemChannel
    : !sessionHoldsPack(resumedSessionId) && !promptPackHeld());
  const promptPack = packDue ? input.pack : [];
  return {
    ...(systemChannel ? { sessionInstruction: text, sessionInstructionBytes: bytes } : {}),
    promptPack,
    freshSessionPromptPack: text !== undefined && !systemChannel ? input.pack : [],
    buildModeDue: resumedSessionId === null
      || nativeGoalSession
      || input.latestTurn?.interactionMode !== conversation.interactionMode
      || !settledOnSession(input.latestTurn),
    recordPromptPack: (turnId) => {
      if (promptPack.length > 0 && !input.promptWithheld) input.deliveries?.record(conversation.id, turnId, digest);
    },
  };
}
