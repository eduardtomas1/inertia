function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validProtocolIdentifier(value: unknown): value is string {
  return nonEmptyString(value) && value.length <= 1_000 && !value.includes("\0");
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validPlanEntry(value: unknown): boolean {
  const entry = record(value);
  return Boolean(entry
    && typeof entry.content === "string"
    && ["high", "medium", "low"].includes(String(entry.priority))
    && ["pending", "in_progress", "completed"].includes(String(entry.status)));
}

function validContentBlock(value: unknown): boolean {
  const content = record(value);
  if (!content || !nonEmptyString(content.type)) return false;
  switch (content.type) {
    case "text":
      return typeof content.text === "string";
    case "image":
    case "audio":
      return typeof content.data === "string" && nonEmptyString(content.mimeType);
    case "resource_link":
      return nonEmptyString(content.uri) && nonEmptyString(content.name);
    case "resource":
      return Boolean(record(content.resource));
    default:
      return false;
  }
}

function validSessionUpdate(update: Record<string, unknown> & { sessionUpdate: string }): boolean {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return validContentBlock(update.content);
    case "tool_call":
      return nonEmptyString(update.toolCallId) && typeof update.title === "string";
    case "tool_call_update":
      return nonEmptyString(update.toolCallId);
    case "plan":
      return Array.isArray(update.entries) && update.entries.every(validPlanEntry);
    case "plan_update": {
      const plan = record(update.plan);
      if (!plan || !nonEmptyString(plan.planId) || !nonEmptyString(plan.type)) return false;
      if (plan.type === "items") return Array.isArray(plan.entries) && plan.entries.every(validPlanEntry);
      if (plan.type === "file") return nonEmptyString(plan.uri);
      return plan.type === "markdown" && typeof plan.content === "string";
    }
    case "plan_removed":
      return nonEmptyString(update.planId);
    case "available_commands_update":
      return Array.isArray(update.availableCommands) && update.availableCommands.every((value) => {
        const command = record(value);
        return Boolean(command
          && nonEmptyString(command.name)
          && typeof command.description === "string");
      });
    case "current_mode_update":
      return nonEmptyString(update.currentModeId);
    case "config_option_update":
      return Array.isArray(update.configOptions);
    case "session_info_update":
      return (update.title === undefined || update.title === null || typeof update.title === "string")
        && (update.updatedAt === undefined || update.updatedAt === null || typeof update.updatedAt === "string");
    case "usage_update":
      return finiteNumber(update.used) && finiteNumber(update.size);
    case "compaction_update": {
      const status = update.status;
      return validProtocolIdentifier(update.compactionId)
        && validProtocolIdentifier(status)
        && (
          update.summary === undefined
          || update.summary === null
          || (
            Array.isArray(update.summary)
            && update.summary.every(validContentBlock)
            && (update.summary.length === 0 || status === "completed")
          )
        )
        && (
          update.error === undefined
          || update.error === null
          || (typeof update.error === "string" && status === "failed")
        )
        && (
          update._meta === undefined
          || update._meta === null
          || Boolean(record(update._meta))
        );
    }
    case "compaction_summary_chunk":
      return validProtocolIdentifier(update.compactionId)
        && validContentBlock(update.content);
    default:
      return false;
  }
}

export function parseAcpSessionNotification(value: unknown): {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate: string };
} {
  const params = record(value);
  const update = record(params?.update);
  if (
    !params
    || typeof params.sessionId !== "string"
    || !params.sessionId
    || params.sessionId.length > 1_000
    || params.sessionId.includes("\0")
    || !update
    || typeof update.sessionUpdate !== "string"
    || !update.sessionUpdate
  ) {
    throw new Error("ACP sent a malformed session update envelope.");
  }
  const typedUpdate = update as Record<string, unknown> & { sessionUpdate: string };
  if (!validSessionUpdate(typedUpdate)) {
    throw new Error("ACP sent a malformed session update envelope.");
  }
  return {
    sessionId: params.sessionId,
    update: typedUpdate,
  };
}

export function validAcpJsonRpcEnvelope(value: unknown): boolean {
  const envelope = record(value);
  if (!envelope || envelope.jsonrpc !== "2.0") return false;
  const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(envelope, key);
  const validId = (id: unknown): boolean => id === null
    || typeof id === "string"
    || (typeof id === "number" && Number.isFinite(id));
  if (typeof envelope.method === "string" && envelope.method.length > 0) {
    if (envelope.method === "session/update" && owns("id")) return false;
    return (!owns("id") || validId(envelope.id)) && !owns("result") && !owns("error");
  }
  if (owns("method") || !owns("id") || !validId(envelope.id)) return false;
  const hasResult = owns("result");
  const hasError = owns("error");
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  const error = record(envelope.error);
  return Boolean(error
    && typeof error.code === "number" && Number.isInteger(error.code)
    && typeof error.message === "string");
}
