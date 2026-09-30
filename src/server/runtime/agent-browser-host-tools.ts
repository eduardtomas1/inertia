import { parseAgentBrowserApproval, type AgentBrowserRequest } from "../../shared/agent-browser-approval.js";
import { z } from "zod";

import type { Conversation } from "../../shared/contracts.js";
import type {
  AgentBrowserCommand,
  AgentBrowserKey,
  AgentBrowserRunIdentity,
} from "../../shared/agent-browser.js";
import type {
  ProviderHostToolCall,
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts.js";
import type {
  RuntimeAgentBrowserBroker,
} from "./agent-browser-broker-client.js";
import { withFrontendBrowserAudit } from "./frontend-browser-audit.js";
import { isSafeApprovalDisplayText } from "../provider/approval-display.js";

const tabIdSchema = z.string().uuid();
const refSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const urlSchema = z.string().min(1).max(4_096).regex(/^[^\u0000]*$/u);
const emptySchema = z.object({}).strict();
const navigateSchema = z.object({ url: urlSchema }).strict();
const keySchema = z.enum([
  "Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space",
]);
const interactSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ref: refSchema }).strict(),
  z.object({
    action: z.literal("type"),
    ref: refSchema,
    text: z.string().max(4_000).regex(/^[^\u0000]*$/u),
    replace: z.boolean().default(true),
  }).strict(),
  z.object({ action: z.literal("press"), key: keySchema }).strict(),
  z.object({
    action: z.literal("scroll"),
    deltaY: z.union([
      z.number().int().min(-2_000).max(-1),
      z.number().int().min(1).max(2_000),
    ]),
  }).strict(),
]);
const tabsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("open"), url: urlSchema.optional() }).strict(),
  z.object({ action: z.literal("activate"), tabId: tabIdSchema }).strict(),
  z.object({ action: z.literal("close"), tabId: tabIdSchema }).strict(),
]);

interface ActionBranch {
  properties: Record<string, { const?: unknown }>;
  required?: string[];
}

export const AGENT_BROWSER_TOOL_NAMES = new Set([
  "inertia_browser_snapshot",
  "inertia_browser_screenshot",
  "inertia_browser_navigate",
  "inertia_browser_interact",
  "inertia_browser_tabs",
]);

export const AGENT_BROWSER_TOOL_DEFINITIONS:
readonly ProviderHostToolDefinition[] = [
  {
    name: "inertia_browser_snapshot",
    description: "Inspect the active page in Inertia's visible Browser. Returns a bounded semantic page snapshot with stable element refs for later browser interactions. Use this native tool instead of launching Playwright when a live Inertia Browser is available.",
    inputValidator: emptySchema,
    readOnly: true,
  },
  {
    name: "inertia_browser_screenshot",
    description: "Capture the active visible Inertia Browser page into the bounded local Evidence timeline. Bitmap bytes stay on the user's device; use inertia_browser_snapshot for provider-visible page inspection.",
    inputValidator: emptySchema,
    readOnly: true,
  },
  {
    name: "inertia_browser_navigate",
    description: "Navigate the active Inertia Browser tab to a validated local development URL. Remote websites stay outside the embedded browser security boundary.",
    inputValidator: navigateSchema,
    readOnly: false,
  },
  {
    name: "inertia_browser_interact",
    description: "Interact with the active visible Inertia Browser page using a semantic ref from inertia_browser_snapshot, a bounded key press, or a bounded scroll. Inertia shows the agent cursor and action in the Browser chrome.",
    inputValidator: interactSchema,
    readOnly: false,
  },
  {
    name: "inertia_browser_tabs",
    description: "List, open, activate, or close pages in the current chat's visible Inertia Browser. At most eight ephemeral tabs are allowed and they share only the Browser's non-persistent hardened session.",
    inputValidator: tabsSchema,
    readOnly: false,
  },
].map((definition) => ({
  ...definition,
  inputSchema: providerInputSchema(definition.inputValidator),
}));

function providerInputSchema(validator: z.ZodType): Record<string, unknown> {
  const { oneOf, ...root } = z.toJSONSchema(validator, { io: "input", target: "draft-7" });
  if (!oneOf) return root;
  const branches = oneOf as ActionBranch[];
  const actions = branches.map((branch) => branch.properties.action!.const as string);
  const fields = new Map<string, { schema: object; required: string[]; optional: string[] }>();
  branches.forEach((branch, index) => {
    for (const [key, schema] of Object.entries(branch.properties)) {
      if (key === "action") continue;
      const field = fields.get(key) ?? { schema, required: [], optional: [] };
      (branch.required?.includes(key) ? field.required : field.optional).push(actions[index]!);
      fields.set(key, field);
    }
  });
  return {
    ...root,
    type: "object",
    properties: {
      action: { type: "string", enum: actions },
      ...Object.fromEntries([...fields].map(([key, field]) => [key, {
        ...field.schema,
        description: [
          field.required.length > 0 ? `Required when action is ${field.required.join(" or ")}.` : "",
          field.optional.length > 0 ? `Optional when action is ${field.optional.join(" or ")}.` : "",
        ].filter(Boolean).join(" "),
      }])),
    },
    required: ["action"],
    additionalProperties: false,
  };
}

function failure(code: string, message: string): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code, message } }) };
}

function commandFor(call: ProviderHostToolCall): AgentBrowserCommand | null {
  switch (call.tool) {
    case "inertia_browser_snapshot":
      emptySchema.parse(call.arguments);
      return { action: "snapshot" };
    case "inertia_browser_screenshot":
      emptySchema.parse(call.arguments);
      return { action: "screenshot" };
    case "inertia_browser_navigate": {
      const args = navigateSchema.parse(call.arguments);
      return { action: "navigate", url: args.url };
    }
    case "inertia_browser_interact": {
      const args = interactSchema.parse(call.arguments);
      switch (args.action) {
        case "click":
          return { action: "click", ref: args.ref };
        case "type":
          return {
            action: "type",
            ref: args.ref,
            text: args.text,
            replace: args.replace,
          };
        case "press":
          return { action: "press", key: args.key as AgentBrowserKey };
        case "scroll":
          return { action: "scroll", deltaY: args.deltaY };
      }
    }
    case "inertia_browser_tabs": {
      const args = tabsSchema.parse(call.arguments);
      switch (args.action) {
        case "list":
          return { action: "tabs" };
        case "open":
          return {
            action: "tab-open",
            ...(args.url ? { url: args.url } : {}),
          };
        case "activate":
          return { action: "tab-activate", tabId: args.tabId };
        case "close":
          return { action: "tab-close", tabId: args.tabId };
      }
    }
    default:
      return null;
  }
}

function requiresApproval(command: AgentBrowserCommand): boolean {
  return command.action !== "snapshot"
    && command.action !== "screenshot"
    && command.action !== "tabs";
}

export class AgentBrowserHostTools {
  constructor(private readonly browser: RuntimeAgentBrowserBroker) {}

  async invoke(
    conversation: Conversation,
    call: ProviderHostToolCall,
    identity: AgentBrowserRunIdentity,
  ): Promise<ProviderHostToolResult> {
    if (identity.conversationId !== conversation.id) {
      return failure("invalid_owner", "The Browser action no longer owns this chat.");
    }
    const command = commandFor(call);
    if (!command) return failure("unknown_tool", "That Inertia browser tool is unavailable.");
    let execution: AgentBrowserRequest = command;
    if (
      conversation.accessMode === "supervised"
      && requiresApproval(command)
    ) {
      const prepared = await this.browser.perform(identity, { action: "prepare-approval", command }, call.signal);
      if (!prepared.ok) return failure(prepared.code, prepared.message);
      const approval = parseAgentBrowserApproval(prepared.text);
      if (!approval) return failure("invalid", "The Browser approval could not be inspected.");
      let approved = false;
      try {
        if (!isSafeApprovalDisplayText(approval.detail, true)) {
          return failure("invalid", "The Browser approval contains unsafe display text.");
        }
        approved = await call.requestApproval({
          title: "Control Inertia Browser",
          detail: approval.detail,
          reason: "This approval applies only to the inspected tab and document.",
          permissionRoots: [],
        }) === "approve" && !call.signal.aborted;
      } finally {
        if (!approved) await this.browser.perform(identity, { action: "discard-approval", token: approval.token })
          .catch(() => undefined);
      }
      if (!approved) return failure("user_denied", "The user did not approve this browser action.");
      execution = { action: "perform-approved", token: approval.token };
    }
    if (call.signal.aborted) {
      return failure("call_cancelled", "The browser action was cancelled.");
    }
    const result = await this.browser.perform(
      identity,
      execution,
      call.signal,
    );
    return result.ok
      ? {
          success: true,
          text: command.action === "snapshot"
            ? withFrontendBrowserAudit(result.text)
            : result.text,
        }
      : failure(result.code, result.message);
  }
}
