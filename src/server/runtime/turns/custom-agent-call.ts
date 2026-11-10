import {
  compileCustomAgentInstructions,
  customAgentDelegationText,
  customAgentDelivery,
  customAgentInlineText,
  customAgentNativeName,
  MAX_CUSTOM_AGENT_INSTRUCTION_BYTES,
  type CustomAgent,
  type CustomAgentCallAttribution,
} from "../../../shared/custom-agents";
import type { RuntimeStore } from "../../database";
import type { ProviderCustomAgentInput, ProviderId } from "../../provider/contracts";
import { RuntimeRequestError, USER_CORRECTABLE_REQUEST } from "../../runtime-errors";
import type { HiddenProviderInstruction } from "./request-context";

export const CUSTOM_AGENT_INSTRUCTION_LABEL = "inertia-custom-agent";

export type CustomAgentCallRejection = "missing" | "too-large" | "goal";

export class CustomAgentCallError extends RuntimeRequestError {
  constructor(readonly reason: CustomAgentCallRejection, message: string) {
    super(message, USER_CORRECTABLE_REQUEST);
    this.name = "CustomAgentCallError";
  }
}

export interface CustomAgentCall {
  attribution: CustomAgentCallAttribution;
  instructionBlock: HiddenProviderInstruction;
  providerInput: { customAgent: ProviderCustomAgentInput };
}

export interface ResolveCustomAgentCallInput {
  calledAgent: { agentId: string };
  store: Pick<RuntimeStore, "customAgents">;
  providerId: ProviderId;
}

function nativeDescription(agent: CustomAgent): string {
  return agent.description.trim()
    || `Custom agent ${agent.name}, called by the user with /calling ${agent.handle}.`;
}

function instructionText(agent: CustomAgent, providerId: ProviderId, instructions: string): string {
  const inline = customAgentInlineText(agent, providerId, instructions);
  if (inline !== null && Buffer.byteLength(inline, "utf8") <= MAX_CUSTOM_AGENT_INSTRUCTION_BYTES) return inline;
  const delegation = customAgentDelegationText(agent, providerId);
  if (delegation !== null) return delegation;
  throw new CustomAgentCallError(
    "too-large",
    `The instructions of ${JSON.stringify(agent.name)} are too long to send with this request. Shorten them in Settings, then send again.`,
  );
}

export function resolveCustomAgentCall(input: ResolveCustomAgentCallInput): CustomAgentCall {
  const agent = input.store.customAgents().get(input.calledAgent.agentId);
  if (!agent) {
    throw new CustomAgentCallError(
      "missing",
      "The custom agent you called no longer exists. Pick another agent or send the message without /calling.",
    );
  }
  const instructions = compileCustomAgentInstructions(agent);
  return {
    attribution: {
      agentId: agent.id,
      revision: agent.revision,
      handle: agent.handle,
      name: agent.name,
      icon: agent.icon,
      accent: agent.accent,
      delivery: customAgentDelivery(input.providerId),
    },
    instructionBlock: {
      label: CUSTOM_AGENT_INSTRUCTION_LABEL,
      text: instructionText(agent, input.providerId, instructions),
    },
    providerInput: {
      customAgent: {
        nativeName: customAgentNativeName(agent.handle),
        description: nativeDescription(agent),
        instructions,
        skills: [...agent.skills],
      },
    },
  };
}

export function rejectGoalCustomAgentCall(): never {
  throw new CustomAgentCallError(
    "goal",
    "A goal can't call a custom agent. Send the message without /calling.",
  );
}
