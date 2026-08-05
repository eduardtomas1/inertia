import { useMemo, useState } from "react";

import {
  PRIVATE_CONNECT_QUESTION_LIMITS,
  type PrivateConnectSafeQuestion,
} from "../../../../shared/private-connect/questions";

type Answers = Record<string, string[]>;

function toggleOption(
  current: string[] | undefined,
  optionId: string,
  allowMultiple: boolean,
): string[] {
  if (!allowMultiple) return [optionId];
  const values = current ?? [];
  return values.includes(optionId)
    ? values.filter((value) => value !== optionId)
    : [...values, optionId];
}

function submittedAnswers(
  questions: readonly PrivateConnectSafeQuestion[],
  selections: Answers,
  custom: Record<string, string>,
): Answers | null {
  const answers: Answers = {};
  for (const question of questions) {
    const typed = (custom[question.id] ?? "").trim();
    const chosen = selections[question.id] ?? [];
    const values = question.allowCustomAnswer && typed.length > 0
      ? question.allowMultiple ? [...chosen, typed] : [typed]
      : chosen;
    if (values.length === 0) return null;
    if (!question.allowMultiple && values.length !== 1) return null;
    answers[question.id] = values;
  }
  return answers;
}

export function QuestionForm({
  questions,
  busy,
  onAnswer,
}: {
  questions: readonly PrivateConnectSafeQuestion[];
  busy: boolean;
  onAnswer: (answers: Answers) => void;
}): React.JSX.Element {
  const [selections, setSelections] = useState<Answers>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answers = useMemo(
    () => submittedAnswers(questions, selections, custom),
    [questions, selections, custom],
  );

  return (
    <form
      className="question-card"
      onSubmit={(event) => {
        event.preventDefault();
        if (answers) onAnswer(answers);
      }}
    >
      <h3>Inertia needs your answer</h3>
      {questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.label}</legend>
          {question.options.map((option) => (
            <label key={option.id}>
              <input
                type={question.allowMultiple ? "checkbox" : "radio"}
                name={question.id}
                checked={selections[question.id]?.includes(option.id) ?? false}
                onChange={() => {
                  setSelections((current) => ({
                    ...current,
                    [question.id]: toggleOption(
                      current[question.id],
                      option.id,
                      question.allowMultiple,
                    ),
                  }));
                  if (!question.allowMultiple) {
                    setCustom((current) => ({ ...current, [question.id]: "" }));
                  }
                }}
              />
              {" "}
              {option.label}
            </label>
          ))}
          {question.allowCustomAnswer && (
            <input
              className="question-custom"
              type="text"
              aria-label={
                question.options.length > 0
                  ? `Another answer for ${question.label}`
                  : `Answer for ${question.label}`
              }
              placeholder={
                question.options.length > 0
                  ? "Or enter another answer"
                  : "Your answer"
              }
              maxLength={PRIVATE_CONNECT_QUESTION_LIMITS.answerCharacters}
              value={custom[question.id] ?? ""}
              disabled={busy}
              onChange={(event) => {
                const value = event.target.value;
                setCustom((current) => ({ ...current, [question.id]: value }));
                if (!question.allowMultiple && value.trim().length > 0) {
                  setSelections((current) => ({ ...current, [question.id]: [] }));
                }
              }}
            />
          )}
        </fieldset>
      ))}
      <button type="submit" disabled={busy || !answers}>Answer</button>
    </form>
  );
}
