import type { AgentThreadManager } from "../agent-thread-manager";
import { FULL_HARNESS_CAPABILITY_OFFER } from "../harness-capabilities";
import type { TurnControllerHooks } from "../turns/turn-controller-types";
import type { WatcherTurnPolicy } from "./watcher-turn-policy";

type WatcherAwareTurnHooks = Required<Pick<
  TurnControllerHooks,
  "capabilityOfferForTurn" | "watcherInstructionsForTurn" | "hostToolsForTurn"
>>;

export function watcherAwareTurnHooks(
  policy: WatcherTurnPolicy,
  manager: () => Pick<AgentThreadManager, "capabilityOfferForTurn" | "bridgeFor"> | undefined,
): WatcherAwareTurnHooks {
  return {
    capabilityOfferForTurn: ({ conversation }) => policy.capabilityOfferFor(
      conversation,
      manager()?.capabilityOfferForTurn(conversation) ?? { instructions: [], offer: FULL_HARNESS_CAPABILITY_OFFER },
    ),
    watcherInstructionsForTurn: (input) => policy.watcherInstructionsFor(input),
    hostToolsForTurn: ({ conversation, turn, offer }) => policy.hostToolsForTurn({ conversation, turn })
      ?? manager()?.bridgeFor({ conversation, turn }, offer),
  };
}
