export type ClaudeFrontmatterValue = string | readonly string[] | null;

export interface ClaudeFrontmatter {
  fields: ReadonlyMap<string, ClaudeFrontmatterValue>;
  body: string;
}

const MAX_FRONTMATTER_LINES = 256;
const MAX_LIST_ITEMS = 256;
const KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]{0,63})[ \t]*:(?:[ \t]+(.*))?$/u;
const NESTED_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*[ \t]*:(?:[ \t]|$)/u;
const YAML_ESCAPES: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\u0007",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\u001b",
  " ": " ",
  "\"": "\"",
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: " ",
  L: " ",
  P: " ",
};

function indentation(line: string): number {
  return /^[ \t]*/u.exec(line)![0].length;
}

function stripPlainComment(value: string): string {
  const comment = /(?:^|[ \t])#/u.exec(value);
  return (comment ? value.slice(0, comment.index) : value).trim();
}

function quotedEnd(text: string, quote: "'" | "\""): number {
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote === "\"" && character === "\\") {
      index += 1;
      continue;
    }
    if (character !== quote) continue;
    if (quote === "'" && text[index + 1] === "'") {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function unescapeDoubleQuoted(content: string): string | null {
  let output = "";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]!;
    if (character !== "\\") {
      output += character;
      continue;
    }
    const escape = content[index + 1];
    if (escape === undefined) return null;
    const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
    if (width > 0) {
      const hex = content.slice(index + 2, index + 2 + width);
      if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`, "u").test(hex)) return null;
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) return null;
      output += String.fromCodePoint(codePoint);
      index += 1 + width;
      continue;
    }
    const replacement = YAML_ESCAPES[escape];
    if (replacement === undefined) return null;
    output += replacement;
    index += 1;
  }
  return output;
}

function foldQuotedLines(text: string): string {
  return text.split("\n").map((line, index, lines) =>
    index === 0
      ? line.replace(/[ \t]+$/u, "")
      : index === lines.length - 1
        ? line.replace(/^[ \t]+/u, "")
        : line.trim()).reduce((folded, line, index) =>
    index === 0 ? line : line === "" ? `${folded}\n` : folded.endsWith("\n")
      ? `${folded}${line}`
      : `${folded} ${line}`, "");
}

function quotedScalar(
  text: string,
): { value: string; rest: string } | null {
  const quote = text[0] === "'" ? "'" : "\"";
  const end = quotedEnd(text, quote);
  if (end < 0) return null;
  const folded = foldQuotedLines(text.slice(1, end));
  const value = quote === "'"
    ? folded.replace(/''/gu, "'")
    : unescapeDoubleQuoted(folded);
  return value === null ? null : { value, rest: text.slice(end + 1) };
}

function flowItem(raw: string): string | null {
  const item = raw.trim();
  if (item === "") return null;
  if (item.startsWith("\"") || item.startsWith("'")) {
    const quoted = quotedScalar(item);
    return quoted && quoted.rest.trim() === "" ? quoted.value : null;
  }
  if (/^[[\]{}&*!|>%@`]/u.test(item)) return null;
  return item;
}

function flowSequence(text: string): readonly string[] | null {
  const items: string[] = [];
  let current = "";
  let index = 1;
  for (; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "\"" || character === "'") {
      const end = quotedEnd(text.slice(index), character);
      if (end < 0) return null;
      current += text.slice(index, index + end + 1);
      index += end;
      continue;
    }
    if (character === "[" || character === "{") return null;
    if (character === "]") break;
    if (character === ",") {
      const item = flowItem(current);
      if (item === null) return null;
      items.push(item);
      current = "";
      continue;
    }
    current += character;
  }
  if (index >= text.length || stripPlainComment(text.slice(index + 1)) !== "") {
    return null;
  }
  if (current.trim() !== "") {
    const item = flowItem(current);
    if (item === null) return null;
    items.push(item);
  }
  return items.length > MAX_LIST_ITEMS ? null : items;
}

function blockScalar(header: string, lines: readonly string[]): string | null {
  if (!/^[|>][1-9]?[-+]?[1-9]?$/u.test(stripPlainComment(header))) return null;
  const content = lines.filter((line) => line.trim() !== "");
  if (content.length === 0) return "";
  const indent = Math.min(...content.map(indentation));
  const dedented = lines.map((line) => line.slice(Math.min(indent, indentation(line))));
  if (header.startsWith("|")) return dedented.join("\n").replace(/\s+$/u, "");
  return dedented.reduce((folded, line) =>
    line === "" ? `${folded}\n` : folded === "" || folded.endsWith("\n")
      ? `${folded}${line}`
      : `${folded} ${line}`, "").trim();
}

function blockSequence(lines: readonly string[]): readonly string[] | null {
  const content = lines.filter((line) => line.trim() !== "");
  const itemIndent = indentation(content[0]!);
  const items: string[] = [];
  for (const line of content) {
    const indent = indentation(line);
    const text = line.slice(indent);
    if (indent === itemIndent) {
      const item = /^-(?:[ \t]+(.*))?$/u.exec(text);
      if (!item) return null;
      items.push(item[1] ?? "");
    } else if (indent > itemIndent && items.length > 0) {
      items[items.length - 1] = `${items[items.length - 1]} ${text}`.trim();
    } else {
      return null;
    }
  }
  if (items.length > MAX_LIST_ITEMS) return null;
  const parsed: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (NESTED_KEY_PATTERN.test(trimmed)) return null;
    const quoted = trimmed.startsWith("\"") || trimmed.startsWith("'");
    const quotedValue = quoted ? quotedScalar(trimmed) : null;
    const value = quoted
      ? quotedValue && stripPlainComment(quotedValue.rest) === "" ? quotedValue.value : null
      : stripPlainComment(trimmed);
    if (
      value === null
      || value === ""
      || (!quoted && /^(?:[[{&*!|>]|-(?:[ \t]|$))/u.test(value))
    ) return null;
    parsed.push(value);
  }
  return parsed;
}

function fieldValue(
  inline: string,
  continuation: readonly string[],
): ClaudeFrontmatterValue {
  const text = inline.trim();
  const content = continuation.filter((line) => line.trim() !== "");
  if (text === "" || text.startsWith("#")) {
    if (content.length === 0) return "";
    const first = content[0]!.trim();
    if (/^-(?:[ \t]|$)/u.test(first)) return blockSequence(continuation);
    if (NESTED_KEY_PATTERN.test(first)) return null;
    if (content.some((line) => indentation(line) === 0)) return null;
    return stripPlainComment(content.map((line) => line.trim()).join(" "));
  }
  if (/^[|>]/u.test(text)) return blockScalar(text, continuation);
  if (text.startsWith("[")) {
    return flowSequence([text, ...continuation.map((line) => line.trim())].join(" "));
  }
  if (text.startsWith("\"") || text.startsWith("'")) {
    const quoted = quotedScalar([text, ...continuation].join("\n"));
    return quoted && stripPlainComment(quoted.rest) === "" ? quoted.value : null;
  }
  if (/^[{&*!%@`]/u.test(text)) return null;
  if (content.some((line) => indentation(line) === 0)) return null;
  return [stripPlainComment(text), ...content.map((line) => stripPlainComment(line))]
    .filter(Boolean)
    .join(" ");
}

export function splitClaudeFrontmatter(
  text: string,
): { lines: string[]; body: string } | null {
  const normalized = text.replace(/^﻿/u, "").replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const lines = normalized.split("\n");
  const closing = lines
    .slice(1, MAX_FRONTMATTER_LINES + 1)
    .findIndex((line) => line.trimEnd() === "---");
  if (closing < 0) return null;
  return {
    lines: lines.slice(1, closing + 1),
    body: lines.slice(closing + 2).join("\n"),
  };
}

export function parseClaudeFrontmatter(text: string): ClaudeFrontmatter | null {
  const sections = splitClaudeFrontmatter(text);
  if (!sections) return null;
  const { lines } = sections;
  const fields = new Map<string, ClaudeFrontmatterValue>();
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    const field = indentation(line) === 0 ? KEY_PATTERN.exec(line) : null;
    index += 1;
    if (!field) continue;
    const start = index;
    while (
      index < lines.length
      && (
        lines[index]!.trim() === ""
        || indentation(lines[index]!) > 0
        || /^-(?:[ \t]|$)/u.test(lines[index]!)
      )
    ) index += 1;
    let end = index;
    while (end > start && lines[end - 1]!.trim() === "") end -= 1;
    fields.set(field[1]!, fieldValue(field[2] ?? "", lines.slice(start, end)));
  }
  return { fields, body: sections.body };
}

export function frontmatterString(
  fields: ReadonlyMap<string, ClaudeFrontmatterValue>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = fields.get(name);
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function frontmatterList(
  value: ClaudeFrontmatterValue | undefined,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items: string[] = [];
  for (const entry of typeof value === "string" ? [value] : value) {
    let current = "";
    let depth = 0;
    for (const character of entry) {
      if (character === "(") depth += 1;
      if (character === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && (character === "," || character === " " || character === "\t")) {
        if (current.trim()) items.push(current.trim());
        current = "";
        continue;
      }
      current += character;
    }
    if (current.trim()) items.push(current.trim());
  }
  return items;
}
