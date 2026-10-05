const MAX_HELD_LINE_CHARS = 1_024;
const MAX_HELD_PRIVATE_KEY_CHARS = 16 * 1_024;
const STREAMED_TAIL_CHARS = 64;
const OPEN_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?![\s\S]*-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----)/u;

interface StreamedCommandOutput {
  held: string;
  chars: number;
  tail: string;
}

export interface CompletedCommandOutput {
  delta: string;
  repeatOutput: boolean;
}

function releasedLength(text: string): number {
  if (
    text.length < MAX_HELD_PRIVATE_KEY_CHARS
    && OPEN_PRIVATE_KEY.test(text)
  ) return 0;
  const end = Math.max(
    text.lastIndexOf("\n"),
    text.lastIndexOf("\r", text.length - 2),
  ) + 1;
  if (text.length - end <= MAX_HELD_LINE_CHARS) return end;
  const space = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\t")) + 1;
  return space > end && text.length - space <= MAX_HELD_LINE_CHARS
    ? space
    : text.length;
}

export class CodexCommandOutput {
  private readonly items = new Map<string, StreamedCommandOutput>();

  append(itemId: string, delta: string): string {
    const item = this.items.get(itemId) ?? { held: "", chars: 0, tail: "" };
    this.items.set(itemId, item);
    item.chars += delta.length;
    item.tail = (item.tail + delta).slice(-STREAMED_TAIL_CHARS);
    const text = item.held + delta;
    const released = releasedLength(text);
    item.held = text.slice(released);
    return text.slice(0, released);
  }

  release(itemId: string): string {
    const item = this.items.get(itemId);
    if (!item) return "";
    const held = item.held;
    item.held = "";
    return held;
  }

  complete(itemId: string, output: string | null): CompletedCommandOutput | null {
    const item = this.items.get(itemId);
    if (!item) return null;
    this.items.delete(itemId);
    if (!output || output.length <= item.chars) {
      return { delta: item.held, repeatOutput: false };
    }
    const continues = output.slice(item.chars - item.tail.length, item.chars)
      === item.tail;
    return continues
      ? { delta: item.held + output.slice(item.chars), repeatOutput: false }
      : { delta: item.held, repeatOutput: true };
  }

  clear(): void {
    this.items.clear();
  }
}
