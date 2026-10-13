const SKILL_NAME_CONTINUATION = /[A-Za-z0-9._:-]/u;
const POTENTIAL_SKILL_TOKEN = /\$([A-Za-z][A-Za-z0-9._:-]{0,159})/gu;
const SHELL_VARIABLE = /^[A-Z_][A-Z0-9_]*$/u;

function shellVariableReference(name: string): boolean {
  return SHELL_VARIABLE.test(name.replace(/[.:-]+$/u, ""));
}

function isPotentialSkillToken(
  content: string,
  index: number,
  name: string,
): boolean {
  const previous = content[index - 1];
  const next = content[index + name.length + 1];
  const startsToken = index === 0
    || (previous !== "\\" && !SKILL_NAME_CONTINUATION.test(previous ?? ""));
  const endsToken = next === undefined
    || !SKILL_NAME_CONTINUATION.test(next);
  return startsToken && endsToken && !shellVariableReference(name);
}

export function containsPotentialSkillInvocation(content: string): boolean {
  for (const match of content.matchAll(POTENTIAL_SKILL_TOKEN)) {
    if (isPotentialSkillToken(content, match.index, match[1]!)) return true;
  }
  return false;
}

export function withoutPotentialSkillInvocations(content: string): string {
  return content.replace(
    POTENTIAL_SKILL_TOKEN,
    (token: string, name: string, index: number) =>
      isPotentialSkillToken(content, index, name) ? " " : token,
  );
}

export function skillDiscoveryIsFresh(
  synchronizedAt: string | null | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (!synchronizedAt) return false;
  const discoveredAt = Date.parse(synchronizedAt);
  return Number.isFinite(discoveredAt) && discoveredAt + ttlMs > now;
}

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
