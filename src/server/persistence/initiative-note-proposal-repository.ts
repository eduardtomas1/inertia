import type Database from "better-sqlite3";

import type { AgentTurn, ChatMessage } from "../../shared/contracts";
import {
  agentInitiativeNoteBodyProblem,
  agentInitiativeNoteTitleProblem,
  initiativeNoteProposalReceiptText,
  MAX_INITIATIVE_NOTE_BODY_BYTES,
  MAX_INITIATIVE_NOTE_PROPOSALS_PER_TURN,
  MAX_INITIATIVE_NOTE_TITLE_CHARS,
  MAX_PENDING_INITIATIVE_NOTE_PROPOSALS,
  MAX_PENDING_INITIATIVE_NOTE_PROPOSALS_PER_CHAT,
  normalizedInitiativeNoteTitle,
  utf8ByteLength,
  type InitiativeNote,
  type InitiativeNoteKind,
} from "../../shared/initiatives";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { neutralizeUntrustedAgentText } from "../runtime/untrusted-agent-text";
import type { InitiativeRepository } from "./initiative-repository";
import type { CreateMessageOptions } from "./types";

export interface InitiativeNoteProposalInput {
  conversationId: string;
  runId: string;
  turnId: string;
  /** As the agent sent them: trimmed, checked, neutralised and measured here. */
  title: string;
  body: string;
  kind: InitiativeNoteKind | null;
  createdAt?: string;
}

export type InitiativeNoteProposalOutcome =
  | { status: "proposed"; note: InitiativeNote; message: ChatMessage; initiativeId: string }
  /** An accepted or proposed note already has this title. */
  | { status: "duplicate"; noteId: string; initiativeId: string }
  /** The user rejected a note with this title before. */
  | { status: "rejected-before"; noteId: string; initiativeId: string };

export type InitiativeNoteProposalErrorCode =
  | "invalid_arguments"
  | "turn_not_active"
  | "not_in_initiative"
  | "initiative_archived"
  /** This turn already proposed as many notes as one turn may. */
  | "proposal_limit_reached"
  /** Too many proposals already wait for the user's review. */
  | "proposal_limit";

/** A refusal the proposing agent is told about; never an internal failure. */
export class InitiativeNoteProposalError extends Error {
  constructor(readonly code: InitiativeNoteProposalErrorCode, message: string) {
    super(message);
    this.name = "InitiativeNoteProposalError";
  }
}

export const NOT_IN_INITIATIVE_MESSAGE = "This chat is no longer in an initiative.";

interface InitiativeNoteProposalStore {
  readonly initiatives: InitiativeRepository;
  assertAgentTurnIdentity(conversationId: string, runId: string, turnId: string): AgentTurn;
  createMessage(
    conversationId: string,
    content: string,
    role: ChatMessage["role"],
    attachments: [],
    turnId: string,
    createdAt: string | undefined,
    options: CreateMessageOptions,
  ): ChatMessage;
}

/**
 * Trims, checks and neutralises an agent's title and body, and measures them
 * as they will be stored: escaping adds characters, so text that no longer
 * fits is refused rather than cut. The one place agent note text is prepared.
 */
function agentNoteText(input: Pick<InitiativeNoteProposalInput, "title" | "body">): { title: string; body: string } {
  const invalid = (message: string) => new InitiativeNoteProposalError("invalid_arguments", message);
  const rawTitle = input.title.trim();
  const rawBody = input.body.trim();
  if (rawTitle === "") throw invalid("The title is blank.");
  if (rawBody === "") throw invalid("The body is blank.");
  const problem = agentInitiativeNoteTitleProblem(rawTitle) ?? agentInitiativeNoteBodyProblem(rawBody);
  if (problem) throw invalid(problem);
  const title = neutralizeUntrustedAgentText(rawTitle);
  const body = neutralizeUntrustedAgentText(rawBody);
  if ([...title].length > MAX_INITIATIVE_NOTE_TITLE_CHARS) {
    throw invalid(`After Inertia escaped instruction-shaped text, the title is longer than ${MAX_INITIATIVE_NOTE_TITLE_CHARS} characters. Shorten it and try again.`);
  }
  if (utf8ByteLength(body) > MAX_INITIATIVE_NOTE_BODY_BYTES) {
    throw invalid(`After Inertia escaped instruction-shaped text, the body is longer than ${MAX_INITIATIVE_NOTE_BODY_BYTES} bytes. Shorten it and try again.`);
  }
  return { title, body };
}

/**
 * Agent note proposals. One transaction resolves the proposing chat's
 * initiative from the chat itself (never from agent input), checks that the
 * exact turn is still active, skips a title the initiative already has or the
 * user rejected, enforces the per-turn limit and the limits on proposals
 * waiting for review, stores the note as an `agent` proposal from this chat,
 * and leaves the proposal's receipt in the chat. Proposals reach no agent until
 * the user accepts them, and count toward the accepted-note limit only then.
 */
export class InitiativeNoteProposalRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly store: InitiativeNoteProposalStore,
  ) {}

  propose(input: InitiativeNoteProposalInput): InitiativeNoteProposalOutcome {
    const { title, body } = agentNoteText(input);
    return this.database.transaction((): InitiativeNoteProposalOutcome => {
      const turn = this.store.assertAgentTurnIdentity(input.conversationId, input.runId, input.turnId);
      if (isAgentTurnTerminalStatus(turn.status)) {
        throw new InitiativeNoteProposalError("turn_not_active", "The turn that proposed this note is no longer active.");
      }
      const initiativeId = this.membership(input.conversationId);
      const normalized = normalizedInitiativeNoteTitle(title);
      const sameTitle = this.store.initiatives.notes.list(initiativeId, { includeRejected: true })
        .filter((note) => normalizedInitiativeNoteTitle(neutralizeUntrustedAgentText(note.title)) === normalized);
      const kept = sameTitle.find(({ state }) => state !== "rejected");
      if (kept) return { status: "duplicate", noteId: kept.id, initiativeId };
      const rejected = sameTitle.at(-1);
      if (rejected) return { status: "rejected-before", noteId: rejected.id, initiativeId };
      if (this.proposalsInTurn(input.turnId) >= MAX_INITIATIVE_NOTE_PROPOSALS_PER_TURN) {
        throw new InitiativeNoteProposalError(
          "proposal_limit_reached",
          `This turn already proposed ${MAX_INITIATIVE_NOTE_PROPOSALS_PER_TURN} notes, the most one turn can propose.`,
        );
      }
      const pending = this.pendingProposals(initiativeId, input.conversationId);
      if (pending.initiative >= MAX_PENDING_INITIATIVE_NOTE_PROPOSALS) {
        throw new InitiativeNoteProposalError(
          "proposal_limit",
          `The initiative already has ${MAX_PENDING_INITIATIVE_NOTE_PROPOSALS} proposals waiting for the user's review; propose more once the user has reviewed some.`,
        );
      }
      if (pending.chat >= MAX_PENDING_INITIATIVE_NOTE_PROPOSALS_PER_CHAT) {
        throw new InitiativeNoteProposalError(
          "proposal_limit",
          `This chat already has ${MAX_PENDING_INITIATIVE_NOTE_PROPOSALS_PER_CHAT} proposals waiting for the user's review; propose more once the user has reviewed them.`,
        );
      }
      const note = this.store.initiatives.notes.create({
        initiativeId,
        title,
        body,
        provenance: "agent",
        sourceConversationId: input.conversationId,
        kind: input.kind,
      });
      const message = this.store.createMessage(
        input.conversationId,
        initiativeNoteProposalReceiptText(note.title),
        "system",
        [],
        input.turnId,
        input.createdAt,
        {
          initiativeContext: {
            initiativeId,
            brief: null,
            notes: null,
            proposal: { noteId: note.id, kind: input.kind },
          },
          activateConversation: false,
        },
      );
      return { status: "proposed", note, message, initiativeId };
    })();
  }

  /** The chat's initiative as it is now; a chat outside one, or in an archived one, cannot propose. */
  private membership(conversationId: string): string {
    const row = this.database.prepare(`
      SELECT initiatives.id AS id, initiatives.status AS status
      FROM conversations
      LEFT JOIN initiatives ON initiatives.id = conversations.initiative_id
      WHERE conversations.id = ?
    `).get(conversationId) as { id: string | null; status: string | null } | undefined;
    if (!row?.id) throw new InitiativeNoteProposalError("not_in_initiative", NOT_IN_INITIATIVE_MESSAGE);
    if (row.status === "archived") {
      throw new InitiativeNoteProposalError(
        "initiative_archived",
        "This chat's initiative is archived, so its notes cannot change.",
      );
    }
    return row.id;
  }

  /** Proposals waiting for review in the initiative, and those from this chat among them. */
  private pendingProposals(initiativeId: string, conversationId: string): { initiative: number; chat: number } {
    return this.database.prepare(`
      SELECT COUNT(*) AS initiative,
        COALESCE(SUM(CASE WHEN source_conversation_id = ? THEN 1 ELSE 0 END), 0) AS chat
      FROM initiative_notes
      WHERE initiative_id = ? AND state = 'proposed'
    `).get(conversationId, initiativeId) as { initiative: number; chat: number };
  }

  /** Proposal receipts are the durable count of what this turn proposed. */
  private proposalsInTurn(turnId: string): number {
    return (this.database.prepare(`
      SELECT COUNT(*) AS count FROM messages
      WHERE turn_id = ? AND role = 'system'
        AND initiative_context_json IS NOT NULL
        AND json_extract(initiative_context_json, '$.proposal') IS NOT NULL
    `).get(turnId) as { count: number }).count;
  }
}
