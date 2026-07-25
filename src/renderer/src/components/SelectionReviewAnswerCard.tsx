import { CircleHelp, X } from "lucide-react";
import type { DiffSelectionReviewAnswer } from "@shared/contracts";
import { IconButton } from "./ui";

export function SelectionReviewAnswerCard({
  answer,
  onDismiss,
}: {
  answer: DiffSelectionReviewAnswer;
  onDismiss?: () => void;
}): React.JSX.Element {
  const model = answer.modelSelection.alias ?? answer.modelSelection.modelId;
  return (
    <aside className="diff-selection-answer" aria-label="Agent answer about selected lines">
      <header>
        <span><CircleHelp size={13} /><strong>Agent answer</strong></span>
        <small>
          {answer.modelSelection.backendProfileDisplayName} · {model} · {answer.selectedLineCount} selected {answer.selectedLineCount === 1 ? "line" : "lines"}
        </small>
        {onDismiss && <IconButton label="Dismiss selection answer" onClick={onDismiss}><X size={12} /></IconButton>}
      </header>
      <blockquote>{answer.question}</blockquote>
      <div className="diff-selection-answer-body">{answer.answer}</div>
    </aside>
  );
}
