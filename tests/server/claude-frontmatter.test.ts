// @inertia-test-suite portable
import { describe, expect, it } from "vitest";

import {
  frontmatterList,
  parseClaudeFrontmatter,
} from "../../src/server/provider/claude-frontmatter";

function fields(...lines: string[]): ReadonlyMap<string, unknown> {
  const parsed = parseClaudeFrontmatter(["---", ...lines, "---", "Body"].join("\n"));
  expect(parsed?.body).toBe("Body");
  return parsed!.fields;
}

describe("Claude front matter", () => {
  it("parses scalars, quotes, comments, and block scalars", () => {
    const parsed = fields(
      "name: researcher # trailing comment",
      "# a comment line",
      "description: \"Says \\\"hi\\\"\\tthen \\u00e9\"",
      "single: 'It''s fine'",
      "colon: Use this: always",
      "literal: |",
      "  first",
      "    indented",
      "",
      "  last",
      "folded: >-",
      "  one",
      "  two",
      "plain: wraps",
      "  onto the next line",
      "empty:",
    );
    expect(parsed.get("name")).toBe("researcher");
    expect(parsed.get("description")).toBe("Says \"hi\"\tthen \u00e9");
    expect(parsed.get("single")).toBe("It's fine");
    expect(parsed.get("colon")).toBe("Use this: always");
    expect(parsed.get("literal")).toBe("first\n  indented\n\nlast");
    expect(parsed.get("folded")).toBe("one two");
    expect(parsed.get("plain")).toBe("wraps onto the next line");
    expect(parsed.get("empty")).toBe("");
  });

  it("parses inline arrays and block sequences in either indentation", () => {
    const parsed = fields(
      "inline: [Read, \"Bash(git status:*)\", 'Grep']",
      "spanning: [Read,",
      "  Write]",
      "indented:",
      "  - Read",
      "  - \"Bash(npm test)\" # comment",
      "compact:",
      "- Glob",
      "- Grep",
      "nothing: []",
    );
    expect(parsed.get("inline")).toEqual(["Read", "Bash(git status:*)", "Grep"]);
    expect(parsed.get("spanning")).toEqual(["Read", "Write"]);
    expect(parsed.get("indented")).toEqual(["Read", "Bash(npm test)"]);
    expect(parsed.get("compact")).toEqual(["Glob", "Grep"]);
    expect(parsed.get("nothing")).toEqual([]);
  });

  it("marks maps, nested lists, anchors, and malformed values as unsupported", () => {
    const parsed = fields(
      "hooks:",
      "  PreToolUse:",
      "    - matcher: Bash",
      "servers:",
      "  - name: github",
      "flow: {a: 1}",
      "nested: [[a]]",
      "anchor: &x value",
      "alias: *x",
      "tagged: !secret value",
      "open: \"never closed",
      "badEscape: \"\\q\"",
      "after: kept",
    );
    for (const key of ["hooks", "servers", "flow", "nested", "anchor", "alias", "tagged", "open", "badEscape"]) {
      expect(parsed.get(key), key).toBeNull();
    }
    expect(parsed.get("after")).toBe("kept");
  });

  it("requires an opening and closing fence and tolerates CRLF and a BOM", () => {
    expect(parseClaudeFrontmatter("name: x\n---\nBody")).toBeNull();
    expect(parseClaudeFrontmatter("---\nname: x\nBody")).toBeNull();
    expect(parseClaudeFrontmatter(`---\n${"a: b\n".repeat(300)}---\nBody`)).toBeNull();
    const parsed = parseClaudeFrontmatter("\uFEFF---\r\nname: x\r\n---\r\nLine one\r\nLine two");
    expect(parsed?.fields.get("name")).toBe("x");
    expect(parsed?.body).toBe("Line one\nLine two");
  });

  it("splits tool lists on commas and spaces outside parentheses", () => {
    expect(frontmatterList("Read, Grep Bash(git status:*), Bash(npm run test)"))
      .toEqual(["Read", "Grep", "Bash(git status:*)", "Bash(npm run test)"]);
    expect(frontmatterList(["Read", "Write, Edit"])).toEqual(["Read", "Write", "Edit"]);
    expect(frontmatterList("")).toEqual([]);
    expect(frontmatterList(null)).toBeUndefined();
    expect(frontmatterList(undefined)).toBeUndefined();
  });
});
