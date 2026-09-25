import { StringDecoder } from "node:string_decoder";

/** BLOB prefixes preserve NULs; join chunks before redaction or UTF-8 decoding. */
export function readBoundedMessageText(
  prefix: Buffer,
  chunks: () => Iterable<{ content: Buffer }>,
  maximumBytes: number,
): { content: string; truncated: boolean } {
  const parts = [prefix];
  let bytes = prefix.length;
  if (bytes <= maximumBytes) {
    for (const chunk of chunks()) {
      parts.push(chunk.content);
      bytes += chunk.content.length;
      if (bytes > maximumBytes) break;
    }
  }
  const truncated = bytes > maximumBytes;
  // Do not invent a replacement character for a code point cut by the cap.
  let content = new StringDecoder("utf8").write(Buffer.concat(
    parts, Math.min(bytes, maximumBytes),
  ));
  // A partial credential may be too short for the redactor to recognize.
  if (truncated) content = content.replace(/\S+$/u, "");
  return { content, truncated };
}

export function readBoundedMessageTail(
  prefixTail: () => Buffer,
  chunksNewestFirst: () => Iterable<{ content: Buffer }>,
  maximumBytes: number,
): string {
  const parts: Buffer[] = [];
  let bytes = 0;
  for (const chunk of chunksNewestFirst()) {
    parts.unshift(chunk.content);
    bytes += chunk.content.length;
    if (bytes >= maximumBytes) break;
  }
  if (bytes < maximumBytes) parts.unshift(prefixTail());
  const joined = Buffer.concat(parts);
  let start = Math.max(0, joined.length - maximumBytes);
  while (start < joined.length && (joined[start]! & 0xc0) === 0x80) start += 1;
  const text = joined.subarray(start).toString("utf8");
  const lineEnd = text.indexOf("\n");
  return lineEnd === -1 ? "" : text.slice(lineEnd + 1);
}
