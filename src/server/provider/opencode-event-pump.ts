import type { Event } from "@opencode-ai/sdk/v2";

import {
  ProviderRunEventBudget,
  PROVIDER_RUN_BUDGET_BURSTS,
} from "./io";
import { openCodeEventRequiresPromptAdmission } from "./opencode-sdk-events";
import {
  OpenCodeSessionOwnership,
  type OpenCodeEventSessionScope,
} from "./opencode-session-ownership";

export const MAX_OPENCODE_EVENT_BYTES = 1024 * 1024;
const MAX_RUN_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_RUN_EVENTS = 8_192;

export interface OpenCodeEventPumpHandlers {
  onOwnedEvent: (
    event: Event,
    scope: Exclude<OpenCodeEventSessionScope, "unrelated">,
    active: boolean,
  ) => void;
  onDescendantLive: () => void;
  onDescendantActivity: () => void;
  onDescendantInteraction: (event: Event) => void | Promise<void>;
  onEvent: (
    event: Event,
    hasLiveDescendants: boolean,
    novelRootActivity: boolean,
  ) => void | Promise<void>;
  isDone: (
    event: Event,
    hasLiveDescendants: boolean,
  ) => boolean | Promise<boolean>;
}

export async function pumpOpenCodeEvents(
  stream: AsyncGenerator<Event>,
  sessionId: string,
  handlers: OpenCodeEventPumpHandlers,
): Promise<void> {
  const maxRunEvents = MAX_RUN_EVENTS * PROVIDER_RUN_BUDGET_BURSTS;
  const sessionOwnership = new OpenCodeSessionOwnership(
    sessionId,
    maxRunEvents,
  );
  const eventBudget = new ProviderRunEventBudget(
    "OpenCode",
    MAX_OPENCODE_EVENT_BYTES,
    MAX_RUN_EVENTS,
    MAX_RUN_EVENT_BYTES,
    { maxRunEvents },
  );
  for await (const event of stream) {
    eventBudget.observe(event);
    const {
      scope,
      active,
      lifecycleProgress,
      novelRootActivity,
    } = sessionOwnership.observe(event);
    if (scope === "unrelated") continue;
    handlers.onOwnedEvent(event, scope, active);
    if (scope === "descendant") {
      if (sessionOwnership.hasLiveDescendants()) handlers.onDescendantLive();
      if (active || lifecycleProgress) handlers.onDescendantActivity();
      if (active && openCodeEventRequiresPromptAdmission(event)) {
        await handlers.onDescendantInteraction(event);
      }
      continue;
    }
    await handlers.onEvent(
      event,
      sessionOwnership.hasLiveDescendants(),
      novelRootActivity === true,
    );
    if (await handlers.isDone(
      event,
      sessionOwnership.hasLiveDescendants(),
    )) return;
  }
  throw new Error("OpenCode closed its event stream before the session completed.");
}
