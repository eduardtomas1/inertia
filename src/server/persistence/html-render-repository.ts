import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { RuntimeHtmlRenderDocument } from "../../node/runtime-html-render-protocol";
import type { AgentTurn, ChatMessage } from "../../shared/contracts";
import {
  HTML_RENDER_MAX_HTML_BYTES,
  clampHtmlRenderHeight,
  htmlRenderPlaceholderText,
  isHtmlRenderId,
  isHtmlRenderTitle,
} from "../../shared/html-render";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { requireTimestamp } from "./codecs";
import type { CreateMessageOptions } from "./types";

export interface CreateHtmlRenderInput {
  conversationId: string;
  runId: string;
  turnId: string;
  title: string;
  html: string;
  height: number;
  createdAt?: string;
}

export interface CreatedHtmlRender {
  renderId: string;
  message: ChatMessage;
}

interface HtmlRenderStore {
  assertAgentTurnIdentity(conversationId: string, runId: string, turnId: string): AgentTurn;
  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"],
    attachments: [],
    turnId: string,
    createdAt: string,
    options: CreateMessageOptions,
  ): ChatMessage;
}

/** The exact source turn settled before the page could be stored. */
export class HtmlRenderTurnInactiveError extends Error {
  constructor() {
    super("The turn that rendered this page is no longer active.");
    this.name = "HtmlRenderTurnInactiveError";
  }
}

/** Stores agent-authored pages and the turn-scoped system messages that reference them. */
export class HtmlRenderRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly store: HtmlRenderStore,
  ) {}

  create(input: CreateHtmlRenderInput): CreatedHtmlRender {
    if (!isHtmlRenderTitle(input.title)) throw new Error("Invalid rendered page title.");
    const bytes = Buffer.byteLength(input.html, "utf8");
    if (bytes === 0 || bytes > HTML_RENDER_MAX_HTML_BYTES) throw new Error("Invalid rendered page size.");
    const height = clampHtmlRenderHeight(input.height);
    const createdAt = input.createdAt === undefined
      ? new Date().toISOString()
      : requireTimestamp(input.createdAt, "Rendered page creation time");
    return this.database.transaction((): CreatedHtmlRender => {
      const turn = this.store.assertAgentTurnIdentity(input.conversationId, input.runId, input.turnId);
      if (isAgentTurnTerminalStatus(turn.status)) throw new HtmlRenderTurnInactiveError();
      const renderId = randomUUID();
      this.database.prepare(`INSERT INTO html_renders (id, conversation_id, turn_id, title, html, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(renderId, input.conversationId, input.turnId, input.title, input.html, createdAt);
      const message = this.store.createMessage(
        input.conversationId,
        htmlRenderPlaceholderText(input.title),
        "system",
        [],
        input.turnId,
        createdAt,
        { htmlRender: { renderId, title: input.title, height }, activateConversation: false },
      );
      return { renderId, message };
    })();
  }

  read(renderId: string): RuntimeHtmlRenderDocument | null {
    if (!isHtmlRenderId(renderId)) return null;
    const row = this.database.prepare("SELECT conversation_id, title, html FROM html_renders WHERE id = ?")
      .get(renderId) as { conversation_id: string; title: string; html: string } | undefined;
    return row ? { conversationId: row.conversation_id, title: row.title, html: row.html } : null;
  }
}
