import { z } from "zod";

import type { AgentTurn, Conversation, RuntimeMutationEvent } from "../../shared/contracts";
import {
  HTML_RENDER_DEFAULT_HEIGHT,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_HTML_BYTES,
  HTML_RENDER_MAX_PER_TURN,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from "../../shared/html-render";
import type { RuntimeStore } from "../database";
import { HtmlRenderLimitReachedError, HtmlRenderTurnInactiveError } from "../persistence/html-render-repository";
import type {
  ProviderHostToolCall,
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";

export const HTML_RENDER_RESULT_MESSAGE =
  "Shown to the reader above your reply. Some clients and later turns see only your text, so say in one sentence what the page shows, then add only what it doesn't already say; don't restate its details or say where it is.";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
// No control characters, and at least one character that survives trimming.
const TITLE_PATTERN = "^[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$";

function codePoints(value: string): number {
  return Array.from(value).length;
}

const htmlSchema = z.string().min(1).refine(
  (value) => Buffer.byteLength(value, "utf8") <= HTML_RENDER_MAX_HTML_BYTES,
  `Too large: expected at most ${HTML_RENDER_MAX_HTML_BYTES} UTF-8 bytes`,
);
const titleSchema = z.string()
  .refine((value) => !CONTROL_CHARACTERS.test(value), "Use one line without control characters")
  .refine((value) => value.trim().length > 0, "Too small: expected a non-blank title")
  .refine(
    (value) => codePoints(value) <= HTML_RENDER_MAX_TITLE_LENGTH,
    `Too long: expected at most ${HTML_RENDER_MAX_TITLE_LENGTH} characters`,
  );
export const htmlRenderInputSchema = z.object({
  html: htmlSchema,
  title: titleSchema,
  height: z.number().int().min(HTML_RENDER_MIN_HEIGHT).max(HTML_RENDER_MAX_HEIGHT)
    .default(HTML_RENDER_DEFAULT_HEIGHT),
}).strict();

const DESCRIPTION = [
  "Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this chat, above your final text reply; call it before writing that reply.",
  "The reader sees the page above the reply, but some clients and later turns see only text: in the reply, say in one sentence what the page shows, then add only what the page doesn't say, without restating its details or saying where it is.",
  "Pass one complete, self-contained HTML document of at most 256 KiB and a short title. Scripts run in a sandbox without network access.",
  `A turn can show at most ${HTML_RENDER_MAX_PER_TURN} pages.`,
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_THEME_GUIDE,
].join(" ");

export const HTML_RENDER_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: HTML_RENDER_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      html: {
        type: "string",
        minLength: 1,
        maxLength: HTML_RENDER_MAX_HTML_BYTES,
        description: `A complete HTML document with inline CSS and scripts. At most ${HTML_RENDER_MAX_HTML_BYTES} UTF-8 bytes.`,
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: HTML_RENDER_MAX_TITLE_LENGTH,
        pattern: TITLE_PATTERN,
        description: "A short label for the page, used as its accessible name.",
      },
      height: {
        type: "integer",
        minimum: HTML_RENDER_MIN_HEIGHT,
        maximum: HTML_RENDER_MAX_HEIGHT,
        default: HTML_RENDER_DEFAULT_HEIGHT,
        description: "Initial frame height in CSS pixels; the page's measured height replaces it once it loads.",
      },
    },
    required: ["html", "title"],
  },
  inputValidator: htmlRenderInputSchema,
  readOnly: true,
  destructive: false,
  idempotent: false,
};

export interface HtmlRenderHostToolDependencies {
  store: Pick<RuntimeStore, "htmlRenders">;
  broadcast(event: RuntimeMutationEvent): void;
}

interface HtmlRenderSource {
  conversation: Conversation;
  turn: AgentTurn;
}

function failure(code: string, message: string): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code, message } }) };
}

function oversized(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const html = (value as Record<string, unknown>).html;
  return typeof html === "string" && Buffer.byteLength(html, "utf8") > HTML_RENDER_MAX_HTML_BYTES;
}

function invalidArguments(error: z.ZodError): ProviderHostToolResult {
  const detail = error.issues.slice(0, 4).map((issue) => {
    const path = issue.path.map(String).join(".");
    return `${path || "arguments"}: ${issue.message}`.slice(0, 200);
  }).join("; ");
  return failure(
    "invalid_arguments",
    `The page was not rendered because its arguments were not accepted (${detail}). Check the tool's input schema and try again.`,
  );
}

// Titles are counted in characters at the tool boundary but stored within
// HTML_RENDER_MAX_TITLE_LENGTH UTF-16 units, so astral characters may shorten one.
function storedTitle(title: string): string {
  let result = "";
  for (const character of title.trim()) {
    if (result.length + character.length > HTML_RENDER_MAX_TITLE_LENGTH) break;
    result += character;
  }
  return result.trimEnd();
}

/** Publishes one agent-authored page as a turn-scoped visual reply. */
export class HtmlRenderHostTool {
  constructor(private readonly dependencies: HtmlRenderHostToolDependencies) {}

  invoke(source: HtmlRenderSource, call: ProviderHostToolCall): ProviderHostToolResult {
    if (oversized(call.arguments)) {
      return failure(
        "html_too_large",
        `The page is larger than ${HTML_RENDER_MAX_HTML_BYTES} UTF-8 bytes. Inline less data or simplify the markup, then try again.`,
      );
    }
    const parsed = htmlRenderInputSchema.safeParse(call.arguments);
    if (!parsed.success) return invalidArguments(parsed.error);
    if (call.signal.aborted) return failure("call_cancelled", "The page render was cancelled.");
    const title = storedTitle(parsed.data.title);
    let created: ReturnType<RuntimeStore["htmlRenders"]["create"]>;
    try {
      created = this.dependencies.store.htmlRenders.create({
        conversationId: source.conversation.id,
        runId: source.turn.runId,
        turnId: source.turn.id,
        title,
        html: parsed.data.html,
        height: parsed.data.height,
      });
    } catch (error) {
      if (error instanceof HtmlRenderTurnInactiveError) return failure("turn_not_active", error.message);
      if (error instanceof HtmlRenderLimitReachedError) {
        return failure(
          "render_limit_reached",
          `This turn already has ${HTML_RENDER_MAX_PER_TURN} rendered pages. Update one of them in your reply instead of adding more.`,
        );
      }
      return failure("render_not_saved", "Inertia could not save the page. Reply in text instead.");
    }
    try {
      this.dependencies.broadcast({ type: "conversation.message.persisted", message: created.message });
    } catch {
      // The page is saved; clients pick it up from the next conversation detail load.
    }
    return {
      success: true,
      text: JSON.stringify({
        rendered: true,
        renderId: created.renderId,
        title,
        message: HTML_RENDER_RESULT_MESSAGE,
      }),
    };
  }
}
