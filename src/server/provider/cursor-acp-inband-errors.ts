import type { SessionNotification } from "@agentclientprotocol/sdk";

import { sanitizeProviderFailureSummary } from "./activity-detail";
import type { ProviderRunFailure } from "./contracts";

const SIGN_IN_REQUIRED = "\n\nPlease sign in to continue";
const USAGE_LIMIT_REACHED = "\n\nUpgrade your plan to continue";
const BACKEND_ERRORS = new Set([
  SIGN_IN_REQUIRED,
  USAGE_LIMIT_REACHED,
  "\n\nAdd a payment method to continue",
  "\n\nCheck your settings to continue",
]);
const BACKEND_ERROR_PREFIX = "\n\nError: ";
const TURN_OUTPUT_UPDATES = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
]);

function backendErrorText(text: string): boolean {
  return BACKEND_ERRORS.has(text)
    || (text.startsWith(BACKEND_ERROR_PREFIX) && text.trim().length > BACKEND_ERROR_PREFIX.trim().length);
}

export class CursorInbandErrors {
  private held: SessionNotification | null = null;
  private heldText: string | null = null;
  private outputSeen = false;

  observe(notification: SessionNotification): SessionNotification[] {
    const update = notification.update;
    if (!TURN_OUTPUT_UPDATES.has(update.sessionUpdate)) return [notification];
    if (
      !this.outputSeen
      && update.sessionUpdate === "agent_message_chunk"
      && update.content.type === "text"
      && backendErrorText(update.content.text)
    ) {
      this.outputSeen = true;
      this.held = notification;
      this.heldText = update.content.text;
      return [];
    }
    this.outputSeen = true;
    const released = this.held ? [this.held, notification] : [notification];
    this.held = null;
    this.heldText = null;
    return released;
  }

  failure(redact: (value: string) => string, workspaceRoot: string): ProviderRunFailure | undefined {
    if (this.heldText === null) return undefined;
    const said = sanitizeProviderFailureSummary(
      redact(this.heldText),
      "Cursor reported an error.",
      { workspaceRoot },
    );
    if (this.heldText === SIGN_IN_REQUIRED) {
      return {
        reason: "provider-error",
        message: "Cursor needs you to sign in. Connect Cursor in provider settings, then try again.",
        technicalDetail: `Cursor: ${said}`,
        phase: "auth",
        terminalEvent: "session/prompt:sign-in-required",
      };
    }
    return {
      reason: "provider-error",
      message: `Cursor: ${said}`,
      phase: "turn",
      terminalEvent: "session/prompt:backend-error",
      ...(this.heldText === USAGE_LIMIT_REACHED ? { usageLimited: true as const } : {}),
    };
  }
}
