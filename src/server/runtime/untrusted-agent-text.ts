/**
 * Neutralizes instruction-shaped text that one agent run produced before
 * Inertia hands it to another model as data. The Claude Agent SDK scans a
 * native subagent's final message this way (Claude Code v2.1.210+); Inertia's
 * cross-chat host tools are a parallel channel that bypasses that scan.
 *
 * Every rewrite only inserts a backslash, so the text stays human-readable:
 *
 * - Control-tag imitation: the `<` of an opening, closing, or self-closing tag
 *   whose name only a harness emits is followed by a backslash, so
 *   `<system-reminder>` becomes `<\system-reminder>` and `</invoke>` becomes
 *   `<\/invoke>`. Matching is case-insensitive and tolerates attributes and
 *   whitespace. Ordinary markup such as `<div>` or `<systemd>` is untouched.
 * - Turn markers: a line whose first non-blank text is `Human:` or
 *   `Assistant:` gets a backslash before the colon (`Human\:`). Mid-line
 *   mentions and the short `H:`/`A:` forms stay as written because they are
 *   common in ordinary Q&A prose.
 * - Inertia's own provider-prompt markers: the section headers and `[label]`
 *   lines that `assembleTurnRequest` and the Gemini history replay emit.
 * - Permission-configuration mentions are left as written, as the SDK does.
 *
 * No pattern matches its own output, so neutralizing is idempotent. No pattern
 * depends on the end of the input either, so every prefix of neutralized text
 * is itself neutralized: truncating after neutralizing stays safe.
 */

const HARNESS_TAG_NAMES = [
  // Claude Code harness blocks.
  "system-reminder",
  "system",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "user-prompt-submit-hook",
  "task-notification",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  // Tool-call wire format.
  "function_calls",
  "function_results",
  "invoke",
  "parameter",
  // Codex harness context blocks.
  "environment_context",
  "user_instructions",
] as const;

const TAG_NAME = `(?:antml:[a-z0-9_.-]+|${HARNESS_TAG_NAMES.join("|")})`;

// These names double as ordinary identifiers. A capitalized opening form glued
// to a preceding identifier is a generic type argument such as
// `List<Parameter>`, not a harness block, so it stays as written. Closing
// forms never occur in generics and are always neutralized.
const IDENTIFIER_TAG_NAMES = new Set(["system", "invoke", "parameter"]);

// Either a tag name directly after `<` or `</`, followed by whitespace, `/`, or
// `>` (so attributes split across lines are still caught), or a bare tag with
// whitespace around the slash and nothing else, so comparisons such as
// `a < system && b > c` stay untouched.
const CONTROL_TAG = new RegExp(
  `<(?=(/?)(${TAG_NAME})[\\s/>]|[ \\t]*(/?)[ \\t]*(${TAG_NAME})[ \\t]*/?>)`,
  "giu",
);

const TURN_MARKER = /^([ \t]*(?:Human|Assistant)[ \t]*):/gmu;

// Headers from request-context.ts assembleTurnRequest. The backslash goes
// before the first colon on the line, which is the header's own terminator.
const INERTIA_SECTION_HEADER = /^([ \t]*(?:Internal provider instructions|Structured execution context)[^\n\r:]*?)(?<!\\):/gimu;

// `[label]` lines: hidden-instruction labels (build mode, capability packs,
// isolated review) and the Gemini reconstructed-history markers.
const INERTIA_SECTION_LABEL = /^([ \t]*)\[(?=(?:build-mode|inertia-orchestration|inertia-frontend-workbench|read-only-diff-review|selected-diff-revision-scope|Inertia application-reconstructed conversation context|End reconstructed context|Current request)\])/gimu;

function neutralizeControlTag(
  match: string,
  directSlash: string | undefined,
  directName: string | undefined,
  spacedSlash: string | undefined,
  spacedName: string | undefined,
  offset: number,
  input: string,
): string {
  const name = directName ?? spacedName ?? "";
  const closing = (directName === undefined ? spacedSlash : directSlash) === "/";
  const identifierUse = !closing
    && IDENTIFIER_TAG_NAMES.has(name.toLowerCase())
    && name !== name.toLowerCase()
    && /[\p{L}\p{N}_$]/u.test(input[offset - 1] ?? "");
  return identifierUse ? match : "<\\";
}

export function neutralizeUntrustedAgentText(value: string): string {
  return value
    .replace(CONTROL_TAG, neutralizeControlTag)
    .replace(TURN_MARKER, "$1\\:")
    .replace(INERTIA_SECTION_HEADER, "$1\\:")
    .replace(INERTIA_SECTION_LABEL, "$1\\[");
}

export function truncateUtf8(value: string, maximumBytes: number): {
  text: string;
  truncated: boolean;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return { text: value, truncated: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maximumBytes;
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

/**
 * Neutralizes first and truncates second, so the byte cap holds even though
 * neutralizing grows the text. `neutralized` reports whether the returned text
 * itself differs from the original, not the discarded tail.
 */
export function boundedUntrustedAgentText(value: string, maximumBytes: number): {
  text: string;
  truncated: boolean;
  neutralized: boolean;
} {
  const bounded = truncateUtf8(neutralizeUntrustedAgentText(value), maximumBytes);
  return { ...bounded, neutralized: !value.startsWith(bounded.text) };
}
