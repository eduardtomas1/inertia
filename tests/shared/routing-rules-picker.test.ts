import { describe, expect, it } from "vitest";

import {
  extractRoutingFeatures,
  ROUTING_FEATURE_SCAN_CHARS,
  routingAttachmentKind,
  type RoutingInput,
} from "../../src/shared/routing/routing-features";
import {
  ROUTING_PICKER_IMPLEMENTATIONS,
  rulesPicker,
  rulesPickerDecision,
} from "../../src/shared/routing/routing-rules-picker";
import type { RoutingTaskKind, RoutingTier } from "../../src/shared/routing/routing-policy";

const base: RoutingInput = {
  content: "",
  attachments: [],
  fileReferenceCount: 0,
  chatMentionCount: 0,
  priorTurnCount: 0,
  previousTurnFailed: false,
  previousTier: null,
};

const STACK_TRACE = [
  "The app crashes on startup with this error:",
  "```",
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "    at loadUser (src/user.ts:42:13)",
  "    at main (src/index.ts:10:3)",
  "```",
  "Please fix it.",
].join("\n");

const PYTHON_TRACE = "Traceback (most recent call last):\n  File \"app.py\", line 3, in <module>\n    main()\nValueError: bad";

type Fixture = [prompt: string, tier: RoutingTier, taskKind: RoutingTaskKind, input?: Partial<RoutingInput>];

/** Expected picker output (before the confidence gate) for representative prompts. */
const FIXTURES: readonly Fixture[] = [
  ["What does this function do?", "light", "question"],
  ["Explain how the websocket reconnect logic works in this repo.", "light", "question"],
  ["Why is the build slow?", "light", "question"],
  ["Quick question: is there a flag to skip hooks?", "light", "question"],
  ["Briefly, what is the difference between let and const?", "light", "question"],
  ["Fix the typo in the README heading", "light", "small_edit"],
  ["Rename getUser to fetchUser everywhere", "light", "small_edit"],
  ["Bump the eslint version", "light", "small_edit"],
  ["Implement OAuth login with refresh tokens, add tests, and wire it into the settings page", "standard", "feature"],
  ["Add a dark mode toggle to the settings page", "standard", "feature"],
  ["Create a new React component for the user avatar", "standard", "feature"],
  [
    "Refactor the payment service into smaller modules and migrate callers. Keep the public API stable and add integration tests for the refund path, the partial capture path and the webhook retries. Update docs.",
    "standard",
    "feature",
  ],
  ["Implement the changes described in these files", "standard", "feature", { fileReferenceCount: 4 }],
  [STACK_TRACE, "heavy", "debugging"],
  [PYTHON_TRACE, "heavy", "debugging"],
  ["Tests are failing after the last merge, can you debug?", "heavy", "debugging"],
  ["How do I fix this error?", "heavy", "debugging"],
  ["Here is a screenshot of the broken layout, fix the overflow", "heavy", "debugging", { attachments: ["image"] }],
  ["Review this PR for security issues and race conditions", "heavy", "review"],
  ["Audit the dependency tree for unmaintained packages", "heavy", "review"],
  ["Can you look over my changes and sanity-check the migration?", "heavy", "review"],
  ["Research how other editors implement multi-cursor undo", "heavy", "research"],
  ["Investigate why memory grows over time in the worker and find out what leaks", "heavy", "research"],
  ["Compare Postgres and SQLite for our offline sync use case and list the trade-offs", "standard", "research"],
  ["Design the architecture for a plugin system with sandboxing, versioning and a migration path", "heavy", "planning"],
  ["Write a plan for splitting the monolith into services", "heavy", "planning"],
  ["Think hard about this: design a lock-free queue for the scheduler and prove it is correct", "max", "planning"],
  ["thanks", "standard", "other"],
  ["Summarise this document", "standard", "other", { attachments: ["document"] }],
  ["Update all of these modules to the new logging API", "standard", "other", { fileReferenceCount: 9 }],
  ["ok do it", "heavy", "other", { priorTurnCount: 3, previousTier: "heavy" }],
  ["continue", "light", "other", { priorTurnCount: 2, previousTier: "light" }],
  ["Try again", "standard", "other", { priorTurnCount: 1, previousTurnFailed: true }],
  ["x".repeat(7_000), "standard", "other"],
];

describe("routing feature extraction", () => {
  it("classifies attachments by MIME type", () => {
    expect(routingAttachmentKind("image/png")).toBe("image");
    expect(routingAttachmentKind("text/markdown")).toBe("text");
    expect(routingAttachmentKind("application/json")).toBe("text");
    expect(routingAttachmentKind("application/pdf")).toBe("document");
    expect(routingAttachmentKind("application/vnd.ms-excel")).toBe("document");
  });

  it("extracts length, code, mentions, attachments and history locally", () => {
    const features = extractRoutingFeatures({
      ...base,
      content: `Fix the bug in @src/app.ts and @lib/util.js\n\`\`\`ts\nconst x = 1;\n\`\`\`\nWhy?`,
      attachments: ["image", "image", "document", "text"],
      fileReferenceCount: 2,
      chatMentionCount: 1,
      priorTurnCount: 4,
      previousTurnFailed: true,
      previousTier: "heavy",
    });
    expect(features).toMatchObject({
      lines: 5,
      codeFences: 1,
      stackTrace: false,
      endsWithQuestion: true,
      attachments: { image: 2, document: 1, text: 1 },
      fileMentions: 4,
      chatMentions: 1,
      firstTurn: false,
      priorTurns: 4,
      previousTurnFailed: true,
      previousTier: "heavy",
    });
    expect(features.keywords.debugging).toBe(2);
    expect(features.keywords.question).toBe(1);
  });

  it("ignores keywords inside code blocks and detects stack traces", () => {
    const quoted = extractRoutingFeatures({ ...base, content: "Summarise\n```\nfix error crash\n```" });
    expect(quoted.keywords.debugging).toBe(0);
    expect(extractRoutingFeatures({ ...base, content: STACK_TRACE }).stackTrace).toBe(true);
    expect(extractRoutingFeatures({ ...base, content: PYTHON_TRACE }).stackTrace).toBe(true);
  });

  it("bounds keyword counts and the scanned prompt", () => {
    const repeated = extractRoutingFeatures({ ...base, content: "fix ".repeat(100) });
    expect(repeated.keywords.debugging).toBe(5);
    const tail = `${"a ".repeat(ROUTING_FEATURE_SCAN_CHARS)} review`;
    expect(extractRoutingFeatures({ ...base, content: tail }).keywords.review).toBe(0);
    expect(extractRoutingFeatures({ ...base, content: tail }).chars).toBe(tail.length);
  });

  it("recognises depth and brevity cues", () => {
    expect(extractRoutingFeatures({ ...base, content: "Think hard about this" }).intensity).toBe("deep");
    expect(extractRoutingFeatures({ ...base, content: "Quickly tell me" }).intensity).toBe("quick");
    expect(extractRoutingFeatures({ ...base, content: "Explain it" }).intensity).toBeNull();
  });
});

describe("rules picker", () => {
  it("covers at least thirty representative prompts", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(30);
  });

  it.each(FIXTURES)("routes %j to %s / %s", (prompt, tier, taskKind, input) => {
    const result = rulesPickerDecision({ ...base, ...input, content: prompt });
    expect({ tier: result.tier, taskKind: result.taskKind }).toEqual({ tier, taskKind });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.trace.length).toBeGreaterThan(0);
  });

  it("is confident about clear cases and unsure about ambiguous ones", () => {
    expect(rulesPickerDecision({ ...base, content: "What does this function do?" }).confidence).toBe(1);
    expect(rulesPickerDecision({ ...base, content: "Fix the typo in the README heading" }).confidence).toBe(1);
    expect(rulesPickerDecision({
      ...base,
      content: "Implement the changes described in these files",
      fileReferenceCount: 4,
    }).confidence).toBe(0);
  });

  it("is deterministic and never names a model", async () => {
    const input = { ...base, content: STACK_TRACE };
    const first = await rulesPicker(input);
    expect(await rulesPicker(input)).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(["confidence", "taskKind", "tier", "trace"]);
    expect(ROUTING_PICKER_IMPLEMENTATIONS.rules).toBe(rulesPicker);
  });
});
