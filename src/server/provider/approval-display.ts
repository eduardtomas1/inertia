const UNSAFE_APPROVAL_FORMATTING =
  /(?:\p{Default_Ignorable_Code_Point}|\p{Zl}|\p{Zp})/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS =
  /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export interface InteractionDisplayTextOptions {
  allowEmpty?: boolean;
  allowLineBreaks?: boolean;
  maxChars: number;
}

/**
 * Approval copy is a security boundary, not ordinary provider output.
 * Reject invisible direction/control characters instead of normalizing them,
 * so the operation the user approves cannot differ from what is displayed.
 */
export function isSafeApprovalDisplayText(
  value: unknown,
  allowLineBreaks = false,
): value is string {
  return typeof value === "string"
    && !UNSAFE_APPROVAL_FORMATTING.test(value)
    && !(allowLineBreaks
      ? CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS.test(value)
      : CONTROL_CHARACTERS.test(value));
}

/**
 * Question and option copy is provider-authored UI. Keep it bounded and reject
 * invisible formatting that could make the displayed choice differ from the
 * value the provider receives.
 */
export function isSafeInteractionDisplayText(
  value: unknown,
  options: InteractionDisplayTextOptions,
): value is string {
  return typeof value === "string"
    && value.length <= options.maxChars
    && (options.allowEmpty === true || value.trim().length > 0)
    && isSafeApprovalDisplayText(value, options.allowLineBreaks === true);
}

/** Canonical key for detecting visually equivalent prompts and option labels. */
export function interactionDisplayIdentity(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}
