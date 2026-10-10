import { describe, expect, it } from "vitest";

import {
  appendProviderActivityOutput,
  MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
  MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
  MAX_PROVIDER_FAILURE_DETAIL_CHARS,
  mergeProviderActivityDetailWithinTurnBudget,
  mergeProviderActivityOutputWithinTurnBudget,
  officialToolResultText,
  providerActivityDetailSections,
  providerFailureActivityDetail,
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "../../src/server/provider/activity-detail";

describe("provider activity detail boundary", () => {
  it("bounds huge output with an explicit head-and-tail omission marker", () => {
    const detail = sanitizeProviderActivityDetail(
      `HEAD\n${"x".repeat(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS * 2)}\nTAIL`,
    );

    expect(detail).not.toBeNull();
    expect(detail!.length).toBeLessThanOrEqual(
      MAX_PROVIDER_ACTIVITY_DETAIL_CHARS,
    );
    expect(detail).toContain("HEAD");
    expect(detail).toContain("characters omitted");
    expect(detail).toContain("TAIL");
  });

  it("strips terminal controls and redacts secrets, paths, and internal prompts", () => {
    const detail = sanitizeProviderActivityDetail(
      [
        "\u001b[31mfailed\u001b[0m\u0000",
        "authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "api_key=ghp_abcdefghijklmnopqrstuvwxyz",
        "system_prompt=\"Never reveal this internal instruction\"",
        "at /Users/alice/project/src/app.ts",
      ].join("\n"),
      {
        workspaceRoot: "/Users/alice/project",
        homeDirectory: "/Users/alice",
      },
    );

    expect(detail).toContain("failed");
    expect(detail).toContain("[redacted]");
    expect(detail).toContain("<workspace>/src/app.ts");
    expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(detail).not.toContain("Never reveal");
    expect(detail).not.toContain("/Users/alice");
  });

  it("redacts credentials passed as environment assignments and command-line options", () => {
    const detail = sanitizeProviderActivityDetail([
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG aws s3 ls",
      "PGPASSWORD=hunter2 psql -h db",
      "GITHUB_TOKEN='tok en' NPM_API_KEY=\"quoted value\" gh pr list",
      "MY_PASS=letmein BUILD_ID=42 PATH_HINT=/opt/bin",
      "curl -u admin:s3cr3tpass https://example.com --user ci:other",
      "mysql --password hunter3 -h db && mysqldump -u root -phunter4 shop",
      "find . -print -path ./x && mkdir -p build && tar -pxf a.tar",
    ].join("\n"));
    expect(detail).toBe([
      "[redacted] aws s3 ls",
      "PGPASSWORD=[redacted] psql -h db",
      "GITHUB_TOKEN=[redacted] NPM_API_KEY=[redacted] gh pr list",
      "MY_PASS=[redacted] BUILD_ID=42 PATH_HINT=/opt/bin",
      "curl -u admin:[redacted] https://example.com --user ci:[redacted]",
      "mysql --password=[redacted] -h db && mysqldump -u root -p[redacted] shop",
      "find . -print -path ./x && mkdir -p build && tar -pxf a.tar",
    ].join("\n"));
    for (const secret of ["wJalrXUtnFEMI", "hunter2", "tok en", "quoted value", "letmein", "s3cr3tpass", "other", "hunter3", "hunter4"]) {
      expect(detail).not.toContain(secret);
    }
  });

  it("redacts registry, cache and cloud credentials given as command arguments but keeps look-alike names and numeric ids", () => {
    const detail = sanitizeProviderActivityDetail([
      "docker login -u bob -p hunter2 registry.example.com",
      "vercel deploy --token abcdefghijkl123 --prod",
      "sshpass -p hunter3 ssh deploy@host",
      "redis-cli -a hunter4 ping",
      "aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG",
      "npm config set //registry.npmjs.org/:_authToken npm_abcdefghijklmnopqrstuvwxyz0123",
      "TOKENIZERS_PARALLELISM=false MONKEY=1 BYPASS_CACHE=1 SORT_KEY=name npm test",
      "SECRET_KEY=topsecret DB_PASSWD=hunter5 STRIPE_API_KEY=sk_live_value CLIENT_CREDENTIALS=creds npm start",
      "docker run -u 1000:1000 node:22 npm test",
    ].join("\n"));
    expect(detail).toBe([
      "docker login -u bob -p [redacted] registry.example.com",
      "vercel deploy --token=[redacted] --prod",
      "sshpass -p [redacted] ssh deploy@host",
      "redis-cli -a [redacted] ping",
      "aws configure set aws_secret_access_key [redacted]",
      "npm config set //registry.npmjs.org/:_authToken [redacted]",
      "TOKENIZERS_PARALLELISM=false MONKEY=1 BYPASS_CACHE=1 SORT_KEY=name npm test",
      "SECRET_KEY=[redacted] DB_PASSWD=[redacted] STRIPE_API_KEY=[redacted] CLIENT_CREDENTIALS=[redacted] npm start",
      "docker run -u 1000:1000 node:22 npm test",
    ].join("\n"));
  });

  it("extracts only official text-shaped results and never stringifies arbitrary payloads", () => {
    expect(officialToolResultText([
      { type: "text", text: "first" },
      { type: "output_text", text: "second" },
    ])).toBe("first\nsecond");
    expect(officialToolResultText({
      command: "do-not-infer-this",
      prompt: "do-not-persist-this",
    })).toBeNull();
    expect(providerActivityDetailSections({
      command: "npm test",
      output: [{ type: "text", text: "passed" }],
    })).toBe("Command:\nnpm test\n\nOutput:\npassed");
  });

  it("enforces the aggregate turn budget while retaining each bounded activity", () => {
    let totalChars = 0;
    const details: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const merged = mergeProviderActivityDetailWithinTurnBudget(
        null,
        `${index}:${"x".repeat(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS)}`,
        totalChars,
      );
      totalChars = merged.totalChars;
      if (merged.detail) details.push(merged.detail);
    }

    expect(totalChars).toBeLessThanOrEqual(
      MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
    );
    expect(details.every((detail) =>
      detail.length <= MAX_PROVIDER_ACTIVITY_DETAIL_CHARS)).toBe(true);
    expect(details.length).toBeLessThan(12);
  });

  it("continues one output section and opens another after other detail", () => {
    let detail = appendProviderActivityOutput(null, "first\n", false);
    detail = appendProviderActivityOutput(detail, "first\n", true);
    detail = appendProviderActivityOutput(detail, "  \n", true);
    detail = `${detail}\n\nTerminal input:\ny`;
    detail = appendProviderActivityOutput(detail, "after input", false);

    expect(detail).toBe(
      "Output:\nfirst\nfirst\n  \n\n\nTerminal input:\ny\n\nOutput:\nafter input",
    );
    expect(appendProviderActivityOutput("Command:\nls", "a", false))
      .toBe("Command:\nls\n\nOutput:\na");
  });

  it("rescans only the open line when output continues", () => {
    const longLine = "x".repeat(4_096);
    expect(appendProviderActivityOutput(
      `Output:\n${longLine} password=`,
      "hunter22\nnext",
      true,
    )).toBe(`Output:\n${longLine} password=[redacted]\nnext`);
    expect(appendProviderActivityOutput(
      "Output:\nkey sk-abcdefghij",
      "klmnopqrstuvwxyz0123\n",
      true,
    )).toBe("Output:\nkey [redacted]\n");
  });

  it("adds no blank line when a redacted prompt line continues the output", () => {
    let detail = "Command:\nrun\n\nOutput:\nstart\n";
    for (let index = 0; index < 6; index += 1) {
      detail = appendProviderActivityOutput(
        detail,
        sanitizeProviderActivityDetail("system prompt: hidden\n", {
          preserveWhitespace: true,
        })!,
        true,
      );
    }

    expect(detail).toBe(
      `Command:\nrun\n\nOutput:\nstart\n${"system_prompt=[redacted]\n".repeat(6)}`,
    );
  });

  it("keeps the command line when the turn budget leaves no room for more detail", () => {
    for (const merged of [
      mergeProviderActivityDetailWithinTurnBudget(
        "Command:\nls",
        "Output:\nmore",
        MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
      ),
      mergeProviderActivityOutputWithinTurnBudget(
        "Command:\nls",
        "more\n",
        false,
        MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS,
      ),
      mergeProviderActivityOutputWithinTurnBudget(
        "Command:\nls",
        "more\n",
        false,
        MAX_PROVIDER_ACTIVITY_DETAIL_PER_TURN_CHARS - 5,
      ),
    ]) {
      expect(merged.detail?.startsWith("Command:\nls")).toBe(true);
    }
  });

  it("keeps streamed output within the activity and turn budgets", () => {
    let detail: string | null = null;
    let totalChars = 0;
    for (let index = 0; index < 100; index += 1) {
      const merged = mergeProviderActivityOutputWithinTurnBudget(
        detail,
        `${index}:${"y".repeat(1_024)}\n`,
        detail !== null,
        totalChars,
      );
      detail = merged.detail;
      totalChars = merged.totalChars;
    }

    expect(detail!.length).toBeLessThanOrEqual(MAX_PROVIDER_ACTIVITY_DETAIL_CHARS);
    expect(totalChars).toBe(detail!.length);
    expect(detail!.startsWith("Output:\n0:")).toBe(true);
    expect(detail!.endsWith(`99:${"y".repeat(1_024)}\n`)).toBe(true);
    expect(detail).toContain("characters omitted");
  });

  it("builds a bounded terminal envelope without duplicating provider metadata", () => {
    const detail = providerFailureActivityDetail({
      reason: "transport-closed",
      phase: "running",
      exitCode: 17,
      signal: null,
      terminalEvent: "not received",
      activityId: "command-42",
      cleanupConfirmed: false,
      workspaceRoot: "/home/alice/project",
      technicalDetail: [
        "Reason: transport-closed",
        "Phase: running",
        "Cause: authorization=Bearer super-secret-value",
        "at /home/alice/project/src/provider.ts:9:2",
        "tail",
        "x".repeat(MAX_PROVIDER_FAILURE_DETAIL_CHARS * 2),
      ].join("\n"),
    });

    expect(detail.length).toBeLessThanOrEqual(
      MAX_PROVIDER_FAILURE_DETAIL_CHARS,
    );
    expect(detail.match(/^Reason:/gmu)).toHaveLength(1);
    expect(detail.match(/^Phase:/gmu)).toHaveLength(1);
    expect(detail).toContain("Exit code: 17");
    expect(detail).toContain("Cleanup: unconfirmed");
    expect(detail).toContain("Recent provider context:");
    expect(detail).toContain("authorization=[redacted]");
    expect(detail).toContain("<workspace>/src/provider.ts");
    expect(detail).not.toContain("super-secret-value");
    expect(detail).not.toContain("/home/alice/project");
  });

  it("keeps the public failure summary single-line, scrubbed, and bounded", () => {
    const summary = sanitizeProviderFailureSummary(
      `Failed at /home/alice/project/src/app.ts\napi_key=ghp_abcdefghijklmnopqrstuvwxyz ${"x".repeat(1_000)}`,
      "Provider failed.",
      {
        workspaceRoot: "/home/alice/project",
        homeDirectory: "/home/alice",
      },
    );

    expect(summary.length).toBeLessThanOrEqual(480);
    expect(summary).not.toContain("\n");
    expect(summary).toBe("Failed at <workspace>/src/app.ts");
    expect(summary).not.toContain("ghp_");
  });
});
