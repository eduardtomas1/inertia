export interface CompactComposerCommand {
  kind: "compact";
  instruction?: string;
}

export function parseCompactComposerCommand(
  value: string,
): CompactComposerCommand | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/iu.exec(value.trim());
  if (!match) return null;
  const instruction = match[1]?.trim();
  return {
    kind: "compact",
    ...(instruction ? { instruction } : {}),
  };
}
