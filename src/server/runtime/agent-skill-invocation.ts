const SKILL_NAME_CONTINUATION = /[A-Za-z0-9._:-]/u;

export function mentionedSkillNames(
  content: string,
  availableNames: readonly string[],
): string[] {
  if (!content.includes("$")) return [];
  const mentioned: Array<{ index: number; name: string }> = [];
  for (const name of new Set(availableNames)) {
    const token = `$${name}`;
    let fromIndex = 0;
    while (fromIndex < content.length) {
      const index = content.indexOf(token, fromIndex);
      if (index < 0) break;
      const previous = content[index - 1];
      const next = content[index + token.length];
      const startsToken = index === 0
        || (
          previous !== "\\"
          && !SKILL_NAME_CONTINUATION.test(previous ?? "")
        );
      const endsToken = next === undefined
        || !SKILL_NAME_CONTINUATION.test(next);
      if (startsToken && endsToken) {
        mentioned.push({ index, name });
        break;
      }
      fromIndex = index + token.length;
    }
  }
  return mentioned
    .sort((left, right) => left.index - right.index)
    .map(({ name }) => name);
}
