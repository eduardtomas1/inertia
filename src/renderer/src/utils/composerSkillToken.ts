export interface ComposerSkillTokenInsertion {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  inserted: boolean;
}

function clampedSelection(value: string, selection: number): number {
  return Math.max(0, Math.min(value.length, selection));
}

function existingTokenRange(
  value: string,
  token: string,
): { start: number; end: number } | null {
  let fromIndex = 0;
  while (fromIndex < value.length) {
    const start = value.indexOf(token, fromIndex);
    if (start < 0) return null;
    const previous = value[start - 1];
    const next = value[start + token.length];
    const boundary = /[A-Za-z0-9._:-]/u;
    if (
      (start === 0 || (previous !== "\\" && !boundary.test(previous ?? "")))
      && (next === undefined || !boundary.test(next))
    ) return { start, end: start + token.length };
    fromIndex = start + token.length;
  }
  return null;
}

function replacementStart(value: string, caret: number): number {
  const prefix = value.slice(0, caret);
  const match = /(?:^|\s)(\$[^\s$]*)$/u.exec(prefix);
  return match?.[1]
    ? caret - match[1].length
    : caret;
}

export function insertComposerSkillToken(
  value: string,
  canonicalName: string,
  rawSelectionStart: number,
  rawSelectionEnd: number,
): ComposerSkillTokenInsertion {
  const token = `$${canonicalName}`;
  const selectionStart = clampedSelection(value, rawSelectionStart);
  const selectionEnd = Math.max(
    selectionStart,
    clampedSelection(value, rawSelectionEnd),
  );
  if (
    selectionStart === selectionEnd
    && selectionEnd === value.length
    && value.slice(replacementStart(value, selectionStart)) === token
  ) {
    return {
      value: `${value} `,
      selectionStart: selectionStart + 1,
      selectionEnd: selectionStart + 1,
      inserted: true,
    };
  }
  const existing = existingTokenRange(value, token);
  if (existing) {
    return {
      value,
      selectionStart: existing.end,
      selectionEnd: existing.end,
      inserted: false,
    };
  }

  const start = selectionStart === selectionEnd
    ? replacementStart(value, selectionStart)
    : selectionStart;
  const before = value.slice(0, start);
  const after = value.slice(selectionEnd);
  const leading = before && !/\s$/u.test(before) ? " " : "";
  const trailing = after
    ? /^\s/u.test(after) ? "" : " "
    : " ";
  const insertedText = `${leading}${token}${trailing}`;
  const next = `${before}${insertedText}${after}`;
  const caret = before.length + insertedText.length;
  return {
    value: next,
    selectionStart: caret,
    selectionEnd: caret,
    inserted: true,
  };
}
