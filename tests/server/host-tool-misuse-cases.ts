import type { ApprovalAnswer, ToolTransport } from "../helpers/agent-tool-surface";

export type MisuseSetup =
  | "managed-child"
  | "idle-managed-child"
  | "foreign-chat"
  | "stale-ref"
  | "non-editable-ref";

export interface MisuseCall {
  tool: string;
  arguments: unknown;
  callId?: string;
}

export interface MisuseExpectation {
  success: boolean;
  code?: string | null;
  includes?: readonly string[];
  matches?: readonly RegExp[];
}

export interface MisuseCase {
  id: string;
  kind: "bad" | "guard" | "control";
  mistake: string;
  browser?: boolean;
  approval?: ApprovalAnswer;
  transports?: readonly ToolTransport[];
  setup?: readonly MisuseSetup[];
  before?: readonly MisuseCall[];
  call: MisuseCall | { batch: readonly MisuseCall[] };
  expect: MisuseExpectation;
  transportExpect?: Partial<Record<ToolTransport, Partial<MisuseExpectation>>>;
  pending?: string | Partial<Record<ToolTransport, string>>;
}

const RAW_ZOD = "returns the raw zod issue JSON as a host_tool_failed message instead of naming the field and the fix";
const CLAUDE_SDK_ZOD = "Claude's MCP SDK validates first and answers 'MCP error -32602: Input validation error' with raw zod issue JSON";
const ORCHESTRATION_ARGUMENT_GAP = { codex: RAW_ZOD, mcp: RAW_ZOD, claude: CLAUDE_SDK_ZOD };
const CLAUDE_ONLY_ARGUMENT_GAP = { claude: CLAUDE_SDK_ZOD };
const NO_CLAUDE_CODE = { claude: { code: null } };
const NAVIGATE = { tool: "inertia_browser_navigate", arguments: { url: "http://localhost:3000/" } };
const OPEN_TAB = { tool: "inertia_browser_open_tab", arguments: {} };

export const MISUSE_CASES: readonly MisuseCase[] = [
  {
    id: "snake-case-conversation-id",
    kind: "bad",
    mistake: "Passes conversation_id instead of conversationId.",
    setup: ["managed-child"],
    call: { tool: "inertia_get_conversation_status", arguments: { conversation_id: "$child" } },
    expect: { success: false, code: "invalid_arguments", includes: ["conversationId", "conversation_id"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: ORCHESTRATION_ARGUMENT_GAP,
  },
  {
    id: "conversation-id-not-uuid",
    kind: "bad",
    mistake: "Passes a chat title as conversationId instead of the id from inertia_list_conversations.",
    call: { tool: "inertia_inspect_conversation", arguments: { conversationId: "Parent chat" } },
    expect: {
      success: false,
      code: "invalid_arguments",
      includes: ["conversationId", "inertia_list_conversations"],
    },
    transportExpect: NO_CLAUDE_CODE,
    pending: ORCHESTRATION_ARGUMENT_GAP,
  },
  {
    id: "list-limit-over-maximum",
    kind: "bad",
    mistake: "Asks inertia_list_conversations for more than 25 chats.",
    call: { tool: "inertia_list_conversations", arguments: { limit: 100 } },
    expect: { success: false, code: "invalid_arguments", includes: ["limit", "25"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: ORCHESTRATION_ARGUMENT_GAP,
  },
  {
    id: "create-whitespace-title",
    kind: "bad",
    mistake: "Creates a chat whose title is only whitespace.",
    call: { tool: "inertia_create_conversation", arguments: { title: "   ", prompt: "Review the parser." } },
    expect: { success: false, code: "invalid_arguments", includes: ["title"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: ORCHESTRATION_ARGUMENT_GAP,
  },
  {
    id: "create-empty-reasoning-effort",
    kind: "bad",
    mistake: "Sends reasoningEffort \"\" instead of omitting it or sending null.",
    call: {
      tool: "inertia_create_conversation",
      arguments: { title: "Verifier", prompt: "Review the parser.", route: { reasoningEffort: "" } },
    },
    expect: { success: false, code: "invalid_arguments", includes: ["reasoningEffort"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: ORCHESTRATION_ARGUMENT_GAP,
  },
  {
    id: "create-unknown-provider",
    kind: "bad",
    mistake: "Routes a new chat to a provider id Inertia does not know.",
    call: {
      tool: "inertia_create_conversation",
      arguments: { title: "Verifier", prompt: "Review the parser.", route: { providerId: "gemini" } },
    },
    expect: { success: false, code: "invalid_arguments", includes: ["providerId", "codex", "claude"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: ORCHESTRATION_ARGUMENT_GAP,
  },
  {
    id: "create-missing-prompt",
    kind: "bad",
    mistake: "Creates a chat with a title but no prompt.",
    call: { tool: "inertia_create_conversation", arguments: { title: "Verifier" } },
    expect: { success: false, code: "invalid_arguments", includes: ["prompt"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: ORCHESTRATION_ARGUMENT_GAP,
  },
  {
    id: "create-valid",
    kind: "control",
    mistake: "None: creates one managed chat after the user approves.",
    call: { tool: "inertia_create_conversation", arguments: { title: "Verifier", prompt: "Review the parser." } },
    expect: { success: true, includes: ["conversationId", "\"status\":\"starting\""] },
  },
  {
    id: "create-approval-denied",
    kind: "guard",
    mistake: "Creates a chat and the user denies the approval.",
    approval: "deny",
    call: { tool: "inertia_create_conversation", arguments: { title: "Verifier", prompt: "Review the parser." } },
    expect: { success: false, code: "user_denied", includes: ["did not approve"] },
  },
  {
    id: "create-approval-timed-out",
    kind: "guard",
    mistake: "Creates a chat and the user never answers the approval.",
    approval: "timeout",
    call: { tool: "inertia_create_conversation", arguments: { title: "Verifier", prompt: "Review the parser." } },
    expect: { success: false, matches: [/timed out|did not answer|no answer|expired/iu] },
    pending: "a timed-out approval returns the same user_denied text as an explicit denial, so the agent cannot tell the user never answered",
  },
  {
    id: "send-to-chat-not-created-here",
    kind: "bad",
    mistake: "Sends a message to a sibling chat that this chat did not create.",
    setup: ["foreign-chat"],
    call: { tool: "inertia_send_message", arguments: { conversationId: "$foreign", content: "Please rebase." } },
    expect: { success: false, includes: ["inertia_create_conversation"] },
    pending: "says the parent lacks 'management authority' without saying that only chats it created with inertia_create_conversation can receive messages",
  },
  {
    id: "latest-result-while-running",
    kind: "bad",
    mistake: "Reads the latest result of a managed chat whose first turn is still running.",
    setup: ["managed-child"],
    call: { tool: "inertia_get_latest_result", arguments: { conversationId: "$child" } },
    expect: { success: true, matches: [/running|active|in progress|not finished/iu] },
    pending: "returns result null without saying the chat is still running or when to check again",
  },
  {
    id: "stop-idle-chat",
    kind: "bad",
    mistake: "Stops a managed chat that has no active turn.",
    setup: ["idle-managed-child"],
    call: { tool: "inertia_stop_conversation", arguments: { conversationId: "$child" } },
    expect: { success: false, includes: ["active turn"] },
  },
  {
    id: "archive-active-chat",
    kind: "bad",
    mistake: "Archives a managed chat while its turn is still running.",
    setup: ["managed-child"],
    call: { tool: "inertia_archive_conversation", arguments: { conversationId: "$child" } },
    expect: { success: false, includes: ["inertia_stop_conversation"] },
    pending: "says 'Stop the managed chat' without naming inertia_stop_conversation",
  },
  {
    id: "archive-idle-chat",
    kind: "control",
    mistake: "None: archives an idle managed chat after approval.",
    setup: ["idle-managed-child"],
    call: { tool: "inertia_archive_conversation", arguments: { conversationId: "$child" } },
    expect: { success: true, includes: ["\"archived\":true"] },
  },
  {
    id: "list-without-arguments",
    kind: "control",
    mistake: "None: lists chats with no arguments.",
    call: { tool: "inertia_list_conversations", arguments: {} },
    expect: { success: true, includes: ["\"conversations\":", "Parent chat"] },
  },
  {
    id: "context-for-this-chat",
    kind: "control",
    mistake: "None: lists this chat's own turns without an approval.",
    call: { tool: "inertia_request_context", arguments: { conversationId: "$self" } },
    expect: { success: true, includes: ["\"access\":\"own\"", "\"turns\":"] },
  },
  {
    id: "context-read-one-turn",
    kind: "control",
    mistake: "None: reads one of this chat's turns in full.",
    call: { tool: "inertia_request_context", arguments: { conversationId: "$self", turnId: "$selfTurn" } },
    expect: { success: true, includes: ["Coordinate the work"] },
  },
  {
    id: "context-limit-on-one-turn",
    kind: "bad",
    mistake: "Passes limit while reading one turn by turnId.",
    call: { tool: "inertia_request_context", arguments: { conversationId: "$self", turnId: "$selfTurn", limit: 5 } },
    expect: { success: false, code: "invalid_arguments", includes: ["limit"] },
  },
  {
    id: "context-turn-without-conversation",
    kind: "bad",
    mistake: "Passes turnId without the conversationId it belongs to.",
    call: { tool: "inertia_request_context", arguments: { turnId: "$selfTurn" } },
    expect: { success: false, code: "invalid_arguments", includes: ["conversationId"] },
  },
  {
    id: "context-turn-with-list-cursor",
    kind: "bad",
    mistake: "Reads one turn with the turn list's nextCursor (a turn id) as cursor.",
    call: {
      tool: "inertia_request_context",
      arguments: { conversationId: "$self", turnId: "$selfTurn", cursor: "$selfTurn" },
    },
    expect: { success: false, includes: ["cursor", "nextCursor"] },
    pending: "says the cursor does not belong to this turn without saying to omit cursor or pass this turn's own nextCursor",
  },
  {
    id: "html-over-byte-limit",
    kind: "bad",
    mistake: "Renders an HTML page larger than 262144 UTF-8 bytes.",
    call: {
      tool: "inertia_render_html",
      arguments: { html: `<!doctype html><p>${"x".repeat(262_144)}</p>`, title: "Big table" },
    },
    expect: { success: false, code: "html_too_large", includes: ["262144"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: CLAUDE_ONLY_ARGUMENT_GAP,
  },
  {
    id: "html-missing-title",
    kind: "bad",
    mistake: "Renders an HTML page without a title.",
    call: { tool: "inertia_render_html", arguments: { html: "<!doctype html><p>Hi</p>" } },
    expect: { success: false, code: "invalid_arguments", includes: ["title"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: CLAUDE_ONLY_ARGUMENT_GAP,
  },
  {
    id: "html-valid",
    kind: "control",
    mistake: "None: renders one small page.",
    call: { tool: "inertia_render_html", arguments: { html: "<!doctype html><p>Hi</p>", title: "Greeting" } },
    expect: { success: true, includes: ["\"rendered\":true"] },
  },
  {
    id: "unknown-tool",
    kind: "bad",
    mistake: "Calls a tool Inertia never offered.",
    call: { tool: "inertia_delete_conversation", arguments: {} },
    expect: {
      success: false,
      matches: [/inertia_delete_conversation/u, /not available|not found|unknown|does not exist/iu],
    },
    pending: {
      codex: "Codex gets 'invalid or unauthorised Inertia tool call' without the tool name",
      mcp: "the runtime answers 'invalid or unauthorised Inertia tool call' without the tool name",
    },
  },
  {
    id: "misspelled-browser-tool",
    kind: "bad",
    mistake: "Calls inertia_browser_snapshots instead of inertia_browser_snapshot.",
    browser: true,
    call: { tool: "inertia_browser_snapshots", arguments: {} },
    expect: { success: false, matches: [/inertia_browser_snapshot(?!s)/u] },
    pending: "the rejection does not suggest the closest tool, inertia_browser_snapshot",
  },
  {
    id: "retired-interact-click",
    kind: "guard",
    mistake: "Calls the retired inertia_browser_interact tool from an older session.",
    browser: true,
    before: [NAVIGATE],
    call: { tool: "inertia_browser_interact", arguments: { action: "click", ref: "e1" } },
    expect: { success: true, includes: ["\"clicked\":\"e1\""] },
    transportExpect: { claude: { success: false, includes: ["inertia_browser_click"] } },
    pending: { claude: "Claude's SDK answers 'Tool inertia_browser_interact not found' without naming inertia_browser_click" },
  },
  {
    id: "retired-interact-navigate",
    kind: "bad",
    mistake: "Asks the retired inertia_browser_interact tool to navigate.",
    browser: true,
    transports: ["codex", "mcp"],
    call: { tool: "inertia_browser_interact", arguments: { action: "navigate", url: "http://localhost:3000/" } },
    expect: { success: false, code: "invalid", includes: ["inertia_browser_navigate"] },
    pending: "lists the retired tool's actions without naming inertia_browser_navigate",
  },
  {
    id: "browser-click-before-navigate",
    kind: "bad",
    mistake: "Clicks in a new chat before opening any page.",
    browser: true,
    call: { tool: "inertia_browser_click", arguments: { ref: "e1" } },
    expect: { success: false, code: "not-found", includes: ["inertia_browser_navigate"] },
    pending: "says 'the navigate tool' instead of naming inertia_browser_navigate",
  },
  {
    id: "browser-snapshot-before-navigate",
    kind: "bad",
    mistake: "Takes a snapshot in a new chat before opening any page.",
    browser: true,
    call: { tool: "inertia_browser_snapshot", arguments: {} },
    expect: { success: true, includes: ["\"blank\":true", "inertia_browser_navigate"] },
    pending: "says 'the navigate tool' instead of naming inertia_browser_navigate",
  },
  {
    id: "browser-navigate-remote",
    kind: "guard",
    mistake: "Navigates to a public website.",
    browser: true,
    call: { tool: "inertia_browser_navigate", arguments: { url: "https://example.com/" } },
    expect: { success: false, code: "invalid", includes: ["localhost", "127.0.0.1"] },
  },
  {
    id: "browser-navigate-local",
    kind: "control",
    mistake: "None: opens a local development page.",
    browser: true,
    call: NAVIGATE,
    expect: { success: true, includes: ["http://localhost:3000"] },
  },
  {
    id: "browser-snapshot-after-navigate",
    kind: "control",
    mistake: "None: reads the page after navigating.",
    browser: true,
    before: [NAVIGATE],
    call: { tool: "inertia_browser_snapshot", arguments: {} },
    expect: { success: true, includes: ["\"inertiaAudit\":"] },
  },
  {
    id: "browser-click-stale-ref",
    kind: "bad",
    mistake: "Clicks a ref from a snapshot taken before the page changed.",
    browser: true,
    setup: ["stale-ref"],
    before: [NAVIGATE],
    call: { tool: "inertia_browser_click", arguments: { ref: "e9" } },
    expect: { success: false, code: "not-found", includes: ["inertia_browser_snapshot"] },
  },
  {
    id: "browser-type-non-editable",
    kind: "bad",
    mistake: "Types into a ref that is a button, not a text field.",
    browser: true,
    setup: ["non-editable-ref"],
    before: [NAVIGATE],
    call: { tool: "inertia_browser_type", arguments: { ref: "e1", text: "hello" } },
    expect: { success: false, code: "invalid", includes: ["inertia_browser_snapshot"] },
    pending: "says the element does not accept text input without saying how to find an editable ref",
  },
  {
    id: "browser-scroll-both",
    kind: "bad",
    mistake: "Scrolls with both deltaY and ref.",
    browser: true,
    call: { tool: "inertia_browser_scroll", arguments: { deltaY: 400, ref: "e1" } },
    expect: { success: false, code: "invalid", includes: ["deltaY", "ref"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: CLAUDE_ONLY_ARGUMENT_GAP,
  },
  {
    id: "browser-scroll-neither",
    kind: "bad",
    mistake: "Scrolls with neither deltaY nor ref.",
    browser: true,
    call: { tool: "inertia_browser_scroll", arguments: {} },
    expect: { success: false, code: "invalid", includes: ["deltaY", "ref"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: CLAUDE_ONLY_ARGUMENT_GAP,
  },
  {
    id: "browser-select-tab-not-uuid",
    kind: "bad",
    mistake: "Selects a tab by a made-up name instead of its id from inertia_browser_tabs.",
    browser: true,
    call: { tool: "inertia_browser_select_tab", arguments: { tabId: "tab-1" } },
    expect: { success: false, code: "invalid", includes: ["tabId", "inertia_browser_tabs"] },
    transportExpect: NO_CLAUDE_CODE,
    pending: {
      codex: "echoes the 85-character tab id regex instead of pointing to inertia_browser_tabs",
      mcp: "echoes the 85-character tab id regex instead of pointing to inertia_browser_tabs",
      claude: CLAUDE_SDK_ZOD,
    },
  },
  {
    id: "browser-ninth-tab",
    kind: "guard",
    mistake: "Opens a ninth Browser tab.",
    browser: true,
    before: [NAVIGATE, OPEN_TAB, OPEN_TAB, OPEN_TAB, OPEN_TAB, OPEN_TAB, OPEN_TAB, OPEN_TAB],
    call: OPEN_TAB,
    expect: { success: false, code: "too-large", includes: ["inertia_browser_close_tab"] },
    pending: "says 'Close a tab' without naming inertia_browser_close_tab",
  },
  {
    id: "reused-call-id",
    kind: "guard",
    mistake: "The provider replays a tool call with an identity it already used.",
    transports: ["codex", "mcp"],
    before: [{ tool: "inertia_list_conversations", arguments: {}, callId: "replayed-call" }],
    call: { tool: "inertia_list_conversations", arguments: {}, callId: "replayed-call" },
    expect: { success: false, matches: [/reused/iu] },
  },
  {
    id: "batched-tool-calls",
    kind: "guard",
    mistake: "Sends two tools/call requests in one JSON-RPC batch.",
    transports: ["mcp"],
    call: {
      batch: [
        { tool: "inertia_list_conversations", arguments: {} },
        { tool: "inertia_request_context", arguments: { conversationId: "$self" } },
      ],
    },
    expect: { success: false, code: "-32600", includes: ["separate"] },
  },
];
