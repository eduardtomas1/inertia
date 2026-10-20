/*
 * The parts of agent note proposals the chat timeline needs. Kept apart from
 * `initiatives.ts` (which re-exports them), whose schemas only the Initiatives page and the runtime
 * load, so the timeline does not pull them into the first load.
 */

/**
 * What an agent says a proposed note records. Kept on the proposal's receipt
 * in the proposing chat; the note itself is a title and a body.
 */
export const INITIATIVE_NOTE_KINDS = ["fact", "decision", "constraint"] as const;
export type InitiativeNoteKind = typeof INITIATIVE_NOTE_KINDS[number];

export const INITIATIVE_NOTE_KIND_LABELS: Readonly<Record<InitiativeNoteKind, string>> = {
  fact: "Fact",
  decision: "Decision",
  constraint: "Constraint",
};

/** True for the receipt an agent's note proposal leaves in its chat. */
export function isInitiativeNoteProposalReceipt<Receipt extends { proposal?: object }>(
  value: Receipt | undefined,
): value is Receipt & { proposal: NonNullable<Receipt["proposal"]> } {
  return value?.proposal !== undefined;
}

/** The timeline text of a proposal receipt; the title is the note's stored (neutralised) title. */
export function initiativeNoteProposalReceiptText(title: string): string {
  return `Proposed an initiative note: ${title}`;
}
