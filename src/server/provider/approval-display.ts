const UNSAFE_APPROVAL_FORMATTING = /(?:\p{Cf}|\p{Zl}|\p{Zp})/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTROL_CHARACTERS_EXCEPT_LINE_BREAKS =
  /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

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
