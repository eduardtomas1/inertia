import type { z } from "zod";

const MAX_PROBLEMS = 6;
const MAX_LINE_CHARS = 200;
const MAX_ECHOED_KEY_CHARS = 80;

type Issue = z.ZodError["issues"][number];

function child(node: unknown, key: PropertyKey): unknown {
  if (node === null || typeof node !== "object") return undefined;
  return (node as Record<string, unknown>)[String(key)];
}

function schemaAt(schema: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>((node, key) => child(child(node, "properties"), key), schema);
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>((node, key) => child(node, key), value);
}

function problem(issue: Issue, args: unknown): string {
  switch (issue.code) {
    case "invalid_type":
      return valueAt(args, issue.path) === undefined ? "required" : `expected ${issue.expected}`;
    case "invalid_format":
      return issue.format === "uuid"
        ? "expected a chat id (UUID) from inertia_list_conversations"
        : issue.message;
    case "too_big":
      return `at most ${String(issue.maximum)}${issue.origin === "string" ? " characters" : ""}`;
    case "too_small":
      return issue.origin === "string" && Number(issue.minimum) === 1
        ? "must not be empty"
        : `at least ${String(issue.minimum)}${issue.origin === "string" ? " characters" : ""}`;
    case "invalid_value":
      return `expected one of ${issue.values.map(String).join(", ")}`;
    default:
      return issue.message;
  }
}

function quotedKey(key: string): string {
  return JSON.stringify(key)
    .replace(/[\u007f-\uffff]/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .slice(0, MAX_ECHOED_KEY_CHARS);
}

function lines(issue: Issue, args: unknown, schema: unknown): string[] {
  const prefix = issue.path.map(String).join(".");
  if (issue.code === "unrecognized_keys") {
    const accepted = Object.keys(child(schemaAt(schema, issue.path), "properties") ?? {});
    return issue.keys.map((key) => `${prefix ? `${prefix}.` : ""}${quotedKey(key)}: unknown field; accepted: ${accepted.join(", ") || "none"}`);
  }
  return [`${prefix || "arguments"}: ${problem(issue, args)}`];
}

export function invalidHostToolArguments(
  tool: string,
  schema: Readonly<Record<string, unknown>> | undefined,
  args: unknown,
  error: z.ZodError,
): string {
  const problems = error.issues
    .flatMap((issue) => lines(issue, args, schema))
    .slice(0, MAX_PROBLEMS)
    .map((line) => line.slice(0, MAX_LINE_CHARS));
  return [...problems, `Fix ${problems.length === 1 ? "it" : "them"} and call ${tool} again.`].join("\n");
}
