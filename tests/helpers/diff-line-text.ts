import type { MatcherFunction } from "@testing-library/react";

/**
 * Matches a rendered diff line by its full content. Syntax spans and
 * intraline `<mark>` elements split the text across nodes, so the default
 * own-text matcher no longer sees a changed line as one string.
 */
export function diffLineText(expected: string | RegExp): MatcherFunction {
  return (_content, element) => {
    if (!element?.classList.contains("diff-line-content")) return false;
    const text = element.textContent ?? "";
    return typeof expected === "string" ? text === expected : expected.test(text);
  };
}
