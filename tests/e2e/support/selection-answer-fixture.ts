import type { DiffSelectionReviewAnswer } from "../../../src/shared/contracts";

function escapeFixtureHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function selectionAnswerFixtureMarkup(
  answer: DiffSelectionReviewAnswer,
): string {
  const model = answer.modelSelection.alias ?? answer.modelSelection.modelId;
  const lineLabel = answer.selectedLineCount === 1 ? "line" : "lines";
  return `
    <aside class="diff-selection-answer" aria-label="Agent answer about selected lines">
      <header>
        <span>
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"></circle>
            <path d="M9.1 9a3 3 0 1 1 5.83 1c0 2-3 2-3 4" fill="none" stroke="currentColor" stroke-width="2"></path>
            <path d="M12 18h.01" stroke="currentColor" stroke-width="2"></path>
          </svg>
          <strong>Agent answer</strong>
        </span>
        <small>${escapeFixtureHtml(answer.modelSelection.backendProfileDisplayName)} · ${escapeFixtureHtml(model)} · ${answer.selectedLineCount} selected ${lineLabel}</small>
        <button type="button" aria-label="Dismiss selection answer" title="Dismiss selection answer" class="icon-button">
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" stroke-width="2"></path>
          </svg>
        </button>
      </header>
      <blockquote>${escapeFixtureHtml(answer.question)}</blockquote>
      <div class="diff-selection-answer-body">${escapeFixtureHtml(answer.answer)}</div>
    </aside>
  `;
}
