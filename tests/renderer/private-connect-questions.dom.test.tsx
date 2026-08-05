import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QuestionForm } from "../../src/renderer/private-connect/src/components/QuestionForm";
import { PRIVATE_CONNECT_QUESTION_LIMITS } from "../../src/shared/private-connect/questions";
import type { PrivateConnectSafeQuestion } from "../../src/shared/private-connect/questions";

const PROVIDER_QUESTION_ID = "toolu_01AbCdEfGhIjKlMnOpQrStUv:question:1";

function question(
  overrides: Partial<PrivateConnectSafeQuestion> = {},
): PrivateConnectSafeQuestion {
  return {
    id: PROVIDER_QUESTION_ID,
    label: "Which branch should the change target?",
    options: [
      { id: "main", label: "main" },
      { id: "develop", label: "develop" },
    ],
    allowMultiple: false,
    allowCustomAnswer: false,
    ...overrides,
  };
}

describe("Private Connect question form", () => {
  it("submits a free-form answer for a question that allows a custom value", () => {
    const onAnswer = vi.fn();
    render(<QuestionForm questions={[question({ allowCustomAnswer: true })]} busy={false} onAnswer={onAnswer} />);
    const input = screen.getByRole("textbox", { name: /Another answer for/u });
    expect(input).toHaveAttribute("maxlength", String(PRIVATE_CONNECT_QUESTION_LIMITS.answerCharacters));
    fireEvent.change(input, { target: { value: "release/2026-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ [PROVIDER_QUESTION_ID]: ["release/2026-08"] });
  });

  it("offers only the provided options when a custom answer is not allowed", () => {
    const onAnswer = vi.fn();
    render(<QuestionForm questions={[question()]} busy={false} onAnswer={onAnswer} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "develop" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ [PROVIDER_QUESTION_ID]: ["develop"] });
  });

  it("labels an option-less question as a plain answer field", () => {
    render(<QuestionForm questions={[question({ options: [], allowCustomAnswer: true })]} busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: /^Answer for/u })).toBeInTheDocument();
  });

  it("keeps submission disabled until every question has an answer", () => {
    const onAnswer = vi.fn();
    render(
      <QuestionForm
        questions={[
          question(),
          question({ id: `${PROVIDER_QUESTION_ID}:2`, label: "Anything else?", options: [], allowCustomAnswer: true }),
        ]}
        busy={false}
        onAnswer={onAnswer}
      />,
    );
    const submit = screen.getByRole("button", { name: "Answer" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "main" }));
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /Anything else/u }), { target: { value: "no" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onAnswer).toHaveBeenCalledWith({
      [PROVIDER_QUESTION_ID]: ["main"],
      [`${PROVIDER_QUESTION_ID}:2`]: ["no"],
    });
  });

  it("never sends both an option and a custom value for a single-answer question", () => {
    const onAnswer = vi.fn();
    render(<QuestionForm questions={[question({ allowCustomAnswer: true })]} busy={false} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("radio", { name: "main" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Another answer for/u }), { target: { value: "custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ [PROVIDER_QUESTION_ID]: ["custom"] });
    fireEvent.change(screen.getByRole("textbox", { name: /Another answer for/u }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("radio", { name: "develop" }));
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenLastCalledWith({ [PROVIDER_QUESTION_ID]: ["develop"] });
  });

  it("combines an option and a custom value only when multiple answers are allowed", () => {
    const onAnswer = vi.fn();
    render(<QuestionForm questions={[question({ allowMultiple: true, allowCustomAnswer: true })]} busy={false} onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "main" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Another answer for/u }), { target: { value: "extra" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(onAnswer).toHaveBeenCalledWith({ [PROVIDER_QUESTION_ID]: ["main", "extra"] });
  });
});
