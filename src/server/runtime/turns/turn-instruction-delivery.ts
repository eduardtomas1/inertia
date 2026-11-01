import { createHash } from "node:crypto";

import { diagnosticContextSchema } from "../../../shared/application-diagnostics";
import type { AgentTurn, Conversation } from "../../../shared/contracts";
import type { IncidentObservation } from "../../../node/application-incidents";
import type { ProviderRunIdentity } from "../../provider/contracts";
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

export function sessionInstructionDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function chatInstruction(conversationId: string): HiddenProviderInstruction {
  return { label: "inertia-chat", text: `This chat's id is ${conversationId}.` };
}

export function instructionPack(
  conversationId: string,
  capabilityInstructions: readonly HiddenProviderInstruction[],
): readonly HiddenProviderInstruction[] {
  return capabilityInstructions.length === 0
    ? []
    : [...capabilityInstructions, chatInstruction(conversationId)];
}

export function sessionInstructionText(
  harnessId: string,
  pack: readonly HiddenProviderInstruction[],
): string | undefined {
  const text = systemInstructionText(pack);
  return text !== undefined
    && watcherHarnessProfile(harnessId).sessionInstruction
    && Buffer.byteLength(text, "utf8") <= MAX_SYSTEM_INSTRUCTION_BYTES
    ? text
    : undefined;
}

export function recordDeferredSessionInstruction(
  store: Pick<RuntimeStore, "turnLedgerRepository">,
  identity: ProviderRunIdentity,
  reportIncident?: (observation: IncidentObservation) => unknown,
): void {
  store.turnLedgerRepository.forgetSessionInstruction(identity.turnId);
  const context = diagnosticContextSchema.safeParse({
    providerId: identity.providerId,
    conversationId: identity.conversationId,
    turnId: identity.turnId,
  });
  reportIncident?.({
    code: "provider.session-instructions-deferred",
    outcome: "recovered",
    context: context.success ? context.data : { providerId: identity.providerId },
  });
}

export const MAX_TRACKED_PROMPT_DELIVERIES = 1_024;

export class PromptInstructionDeliveries {
  private readonly sent = new Map<string, { turnId: string; digest: string }>();

  record(conversationId: string, turnId: string, digest: string): void {
    this.sent.delete(conversationId);
    this.sent.set(conversationId, { turnId, digest });
    while (this.sent.size > MAX_TRACKED_PROMPT_DELIVERIES) this.sent.delete(this.sent.keys().next().value!);
  }

  sentTurnId(conversationId: string, digest: string): string | null {
    const delivery = this.sent.get(conversationId);
    if (delivery?.digest !== digest) return null;
    this.sent.delete(conversationId);
    this.sent.set(conversationId, delivery);
    return delivery.turnId;
  }

  forget(conversationId: string): void {
    this.sent.delete(conversationId);
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
  sessionInstructionDigest?: string;
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
  const settledOnSession = (turn: AgentTurn | null): boolean => turn !== null
    && turn.status === "completed"
    && turn.origin !== "cli-import"
    && turn.providerSessionAfter === resumedSessionId
    && (turn.providerSessionBefore === null || turn.providerSessionBefore === turn.providerSessionAfter)
    && !ledger.promptWithheld(turn.id)
    && !ledger.compactedSince(conversation.id, turn.requestedAt);
  const text = systemInstructionText(input.pack);
  const systemChannel = sessionInstructionText(input.harnessId, input.pack) !== undefined;
  const digest = text === undefined ? "" : sessionInstructionDigest(text);
  const sessionHoldsPack = (sessionId: string): boolean => {
    if (!systemChannel) return false;
    const origin = ledger.sessionOrigin(conversation.id, sessionId);
    if (origin === null) return false;
    const compaction = watcherHarnessProfile(input.harnessId).sessionInstructionRecordedAtCompaction
      ? ledger.latestCompaction(conversation.id, origin.requestedAt)
      : null;
    if (compaction !== null) return compaction.sessionInstructionDigest === digest;
    return origin.sessionInstructionDigest === digest
      && !ledger.compactedSince(conversation.id, origin.requestedAt);
  };
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
    ...(systemChannel ? { sessionInstruction: text, sessionInstructionDigest: digest } : {}),
    promptPack,
    freshSessionPromptPack: text !== undefined && !systemChannel ? input.pack : [],
    buildModeDue: resumedSessionId === null
      || input.latestTurn?.interactionMode !== conversation.interactionMode
      || !settledOnSession(input.latestTurn),
    recordPromptPack: (turnId) => {
      if (promptPack.length > 0 && !input.promptWithheld) input.deliveries?.record(conversation.id, turnId, digest);
    },
  };
}
