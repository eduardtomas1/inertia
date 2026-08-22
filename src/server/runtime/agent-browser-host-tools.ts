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

const tabIdSchema = z.string().uuid();
const refSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const urlSchema = z.string().min(1).max(4_096).refine((value) => !value.includes("\0"));
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
    text: z.string().max(4_000).refine((value) => !value.includes("\0")),
    replace: z.boolean().default(true),
  }).strict(),
  z.object({ action: z.literal("press"), key: keySchema }).strict(),
  z.object({
    action: z.literal("scroll"),
    deltaY: z.number().int().min(-2_000).max(2_000).refine((value) => value !== 0),
  }).strict(),
]);
const tabsSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("open"), url: urlSchema.optional() }).strict(),
  z.object({ action: z.literal("activate"), tabId: tabIdSchema }).strict(),
  z.object({ action: z.literal("close"), tabId: tabIdSchema }).strict(),
]);

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
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    inputValidator: emptySchema,
    readOnly: true,
  },
  {
    name: "inertia_browser_screenshot",
    description: "Capture the active visible Inertia Browser page as bounded PNG visual evidence. The screenshot is returned directly to the model and is never written into the project.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    inputValidator: emptySchema,
    readOnly: true,
  },
  {
    name: "inertia_browser_navigate",
    description: "Navigate the active Inertia Browser tab to a validated local development URL. Remote websites stay outside the embedded browser security boundary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string", minLength: 1, maxLength: 4_096 } },
      required: ["url"],
    },
    inputValidator: navigateSchema,
    readOnly: false,
  },
  {
    name: "inertia_browser_interact",
    description: "Interact with the active visible Inertia Browser page using a semantic ref from inertia_browser_snapshot, a bounded key press, or a bounded scroll. Inertia shows the agent cursor and action in the Browser chrome.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { enum: ["click", "type", "press", "scroll"] },
        ref: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        text: { type: "string", maxLength: 4_000 },
        replace: { type: "boolean", default: true },
        key: { enum: [...keySchema.options] },
        deltaY: { type: "integer", minimum: -2_000, maximum: 2_000 },
      },
      required: ["action"],
    },
    inputValidator: interactSchema,
    readOnly: false,
  },
  {
    name: "inertia_browser_tabs",
    description: "List, open, activate, or close pages in the current chat's visible Inertia Browser. At most eight ephemeral tabs are allowed and they share only the Browser's non-persistent hardened session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { enum: ["list", "open", "activate", "close"] },
        url: { type: "string", minLength: 1, maxLength: 4_096 },
        tabId: { type: "string", format: "uuid" },
      },
      required: ["action"],
    },
    inputValidator: tabsSchema,
    readOnly: false,
  },
] as const;

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

function actionLabel(command: AgentBrowserCommand): string {
  switch (command.action) {
    case "navigate": return `Navigate to ${command.url}`;
    case "click": return `Click ${command.ref}`;
    case "type": return `Type into ${command.ref}`;
    case "press": return `Press ${command.key}`;
    case "scroll": return `Scroll ${command.deltaY > 0 ? "down" : "up"}`;
    case "tab-open": return "Open a browser tab";
    case "tab-activate": return "Switch browser tabs";
    case "tab-close": return "Close a browser tab";
    case "snapshot": return "Inspect the browser page";
    case "screenshot": return "Capture the browser page";
    case "tabs": return "List browser tabs";
  }
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
    if (
      conversation.accessMode === "supervised"
      && requiresApproval(command)
    ) {
      const decision = await call.requestApproval({
        title: "Control Inertia Browser",
        detail: actionLabel(command),
        reason: "The agent requested an interaction in the visible Inertia Browser.",
        permissionRoots: [],
      });
      if (decision !== "approve") {
        return failure("user_denied", "The user did not approve this browser action.");
      }
    }
    if (call.signal.aborted) {
      return failure("call_cancelled", "The browser action was cancelled.");
    }
    const result = await this.browser.perform(
      identity,
      command,
      call.signal,
    );
    return result.ok
      ? {
          success: true,
          text: result.text,
          ...(result.image ? { image: result.image } : {}),
        }
      : failure(result.code, result.message);
  }
}
