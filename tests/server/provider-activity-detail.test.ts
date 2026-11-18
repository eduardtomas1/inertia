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

  it.each([
    [
      "a quoted macOS path with a space",
      `KEY="$(cat '/Users/bob/Library/Application Support/Inertia/agent-secrets/0123456789abcdef0123456789abcdef/key')" tailscale up`,
      `KEY="$(cat '<path>')" tailscale up`,
    ],
    [
      "a double-quoted Linux path",
      `cat "/home/bob/.config/Inertia/agent-secrets/0123456789abcdef0123456789abcdef/key" | wc -c`,
      `cat "<path>" | wc -c`,
    ],
    [
      "a quoted Windows path with a space",
      `$key = Get-Content -Raw 'C:\\Users\\Bob Smith\\AppData\\Roaming\\Inertia\\agent-secrets\\0123\\key'; login`,
      `$key = Get-Content -Raw '<path>'; login`,
    ],
    ["an unquoted temporary path before a quote", `echo '/tmp/build/out' done`, `echo '<path>' done`],
    ["an unquoted POSIX path ending at a quote", `printf %s /private/tmp/a/b"x"`, `printf %s <path>"x"`],
    ["an escaped space in a POSIX path", `cat /Users/bob/Library/Application\\ Support/x.json; ls`, `cat <path>; ls`],
    ["an unquoted Windows path before a quote", `type C:\\Temp\\a\\b.txt"`, `type <path>"`],
  ])("hides %s and keeps the quotes around it", (_label, input, expected) => {
    expect(sanitizeProviderActivityDetail(input, { homeDirectory: "/nonexistent-home" })).toBe(expected);
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

  it("redacts xAI, Gemini and Groq key formats and credential query parameters", () => {
    const detail = sanitizeProviderActivityDetail([
      "grok failed with xai-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "gemini echoed AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI back",
      "groq rejected gsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      "GET https://maps.example.test/geocode?address=x&key=plainvalue123&page=2",
      "GET https://api.example.test/v1?client_secret=opaque-client-value&page=2",
      "GET https://api.example.test/v1?token=opaque-token-value&page=2",
      "GET https://api.example.test/v1?access_token=opaque-access-value#frag",
      "GET https://api.example.test/v1?api_key=opaque-api-value&token=opaque-token-value",
    ].join("\n"), { homeDirectory: "/nonexistent-home" });
    expect(detail?.split("\n").slice(0, 5)).toEqual([
      "grok failed with [redacted]",
      "gemini echoed [redacted] back",
      "groq rejected [redacted]",
      "GET https://maps.example.test/geocode?address=x&key=[redacted]&page=2",
      "GET https://api.example.test/v1?client_secret=[redacted]&page=2",
    ]);
    for (const secret of ["opaque-access-value", "opaque-api-value", "opaque-token-value"]) {
      expect(detail).not.toContain(secret);
    }
    expect(sanitizeProviderActivityDetail(
      "GET https://example.test/?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI",
    )).toBe("GET https://example.test/?key=[redacted]");
  });

  it("keeps ordinary query parameters and look-alike words", () => {
    const text = "GET https://example.test/search?q=xai-sdk&page=2&monkeys=3 then install gsk_tools and AIzawa";
    expect(sanitizeProviderActivityDetail(text, { homeDirectory: "/nonexistent-home" })).toBe(text);
  });

  it("redacts auth, code, jwt and session query parameters, including percent-encoded ones", () => {
    const options = { homeDirectory: "/nonexistent-home" };
    expect(sanitizeProviderActivityDetail([
      "GET https://idp.example.test/cb?code=4%2F0AXauth-code-value&state=opaque-state",
      "GET https://idp.example.test/cb?device_code=device-code-value&scope=read",
      "GET https://api.example.test/v1?auth=auth-value&jwt=jwt-value&page=2",
      "GET https://api.example.test/v1?session=session-value&session_id=session-id-value&sessionid=sid-value",
      "GET https://app.example.test/login?next=https%3A%2F%2Fapp.example.test%2Fcb%3Ftoken%3Dencoded-token-value%26page%3D2",
      "GET https://app.example.test/login?next=%2Fcb%3Bsession%3Dencoded-session-value%23frag",
      "GET https://app.example.test/v1?zipcode=94110&unicode=1&page=2",
    ].join("\n"), options)?.split("\n")).toEqual([
      "GET https://idp.example.test/cb?code=[redacted]&state=opaque-state",
      "GET https://idp.example.test/cb?device_code=[redacted]&scope=read",
      "GET https://api.example.test/v1?auth=[redacted]&jwt=[redacted]&page=2",
      "GET https://api.example.test/v1?session=[redacted]&session_id=[redacted]&sessionid=[redacted]",
      "GET https://app.example.test/login?next=https%3A%2F%2Fapp.example.test%2Fcb%3Ftoken%3D[redacted]%26page%3D2",
      "GET https://app.example.test/login?next=%2Fcb%3Bsession%3D[redacted]%23frag",
      "GET https://app.example.test/v1?zipcode=94110&unicode=1&page=2",
    ]);
  });

  it("scrubs long adversarial percent-encoded and keyword runs in linear time", () => {
    const inputs = [
      `?${"a".repeat(200_000)}`,
      `%3F${"%41".repeat(70_000)}`,
      "&session".repeat(25_000),
      "%26code".repeat(30_000),
      `?code%3D${"%2".repeat(100_000)}`,
      `?${"_".repeat(63)}token%3`.repeat(3_000),
      "?a%3Dauth%3D".repeat(20_000),
    ];
    const startedAt = performance.now();
    for (const input of inputs) sanitizeProviderActivityDetail(input, { maxChars: Number.MAX_SAFE_INTEGER });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("scrubs adversarial query-parameter runs in linear time", () => {
    const startedAt = performance.now();
    sanitizeProviderActivityDetail("?a".repeat(50_000), { maxChars: Number.MAX_SAFE_INTEGER });
    sanitizeProviderActivityDetail(`?${"%41".repeat(30_000)}`, { maxChars: Number.MAX_SAFE_INTEGER });
    sanitizeProviderActivityDetail("&key=".repeat(20_000), { maxChars: Number.MAX_SAFE_INTEGER });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("cuts only to the caller's bound after scrubbing, even when scrubbing lengthens the text", () => {
    const detail = "psql postgres://admin:pw@db.internal/app --tail-marker";
    expect(sanitizeProviderActivityDetail(detail)).toBe("psql postgres://admin:[redacted]@db.internal/app --tail-marker");
    expect(sanitizeProviderActivityDetail(detail, { maxChars: 20 })).toHaveLength(20);
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

  it.each([
    ["deploy --api-key 9f8e7d6c5b4a39281706f5e4 --region eu", "deploy --api-key [redacted] --region eu"],
    ["oauth login --client-secret abc", "oauth login --client-secret [redacted]"],
    ["sync --access-token abc --force", "sync --access-token [redacted] --force"],
    ["export github_token=abc && gh pr list", "export github_token=[redacted] && gh pr list"],
    ["gh secret set DEPLOY_KEY --body abc", "gh secret set DEPLOY_KEY --body [redacted]"],
  ])("persists the command %j with its secret scrubbed", (command, scrubbed) => {
    const detail = sanitizeProviderActivityDetail(providerActivityDetailSections({
      command,
      output: "done",
    }));
    expect(detail).toBe(`Command:\n${scrubbed}\n\nOutput:\ndone`);
  });
});
