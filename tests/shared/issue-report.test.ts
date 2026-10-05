import { expect, it } from "vitest";
import { providerIdSchema } from "../../src/shared/contracts/client-command/common";
import { REPORT_BODY_LIMIT, REPORT_PROVIDER_IDS } from "../../src/shared/issue-report";
import { scrubReportText } from "../../src/shared/issue-report-scrub";

it.each([
  "ENOENT: no such file or directory, open 'config.json'",
  "ERROR: the turn stopped after cancellation",
  "HTTP: 500 Internal Server Error",
  "PASSED: 3 tests",
  "Expected: a new message to start",
])("keeps an ordinary labelled line: %s", (line) => {
  expect(scrubReportText(`The chat stopped.\n${line}\nThen nothing happened.`)).toBe(`The chat stopped.\n${line}\nThen nothing happened.`);
});

it.each([
  ["AUTH_KEY=never-copy", "AUTH_KEY=[redacted secret]"],
  ["OPENAI_API_KEY=sk_live-value", "OPENAI_API_KEY=[redacted token]"],
  ["GITHUB_TOKEN: synthetic-token-value", "GITHUB_TOKEN: [redacted secret]"],
  ["AWS_SECRET_ACCESS_KEY = synthetic+secret-value", "AWS_SECRET_ACCESS_KEY = [redacted secret]"],
  ["DB_PASSWORD='quoted value' and more", "DB_PASSWORD=[redacted secret] and more"],
  ["SESSION_COOKIE=\"cookie value\"", "SESSION_COOKIE=[redacted secret]"],
  ["password: hidden", "password: [redacted secret]"],
  ["api_key = plain", "api_key = [redacted secret]"],
  ["GITHUB_PAT=0123456789abcdef", "GITHUB_PAT=[redacted secret]"],
  ["NPM_AUTH=npm-value", "NPM_AUTH=[redacted secret]"],
  ["AWS_SESSION=session-value", "AWS_SESSION=[redacted secret]"],
  ["PRIVATE_KEY_ID=key-id-value", "PRIVATE_KEY_ID=[redacted secret]"],
  ["DATABASE_HOST=db.internal.example", "DATABASE_HOST=[redacted secret]"],
  ["WARN=1", "WARN=[redacted secret]"],
  ["auth: plain-value", "auth: [redacted secret]"],
  ["X-Auth-Token: header-value", "X-Auth-Token: [redacted secret]"],
  ["x-api-key: header-value", "x-api-key: [redacted secret]"],
  ["session_id = sid-value", "session_id = [redacted secret]"],
  ["bearer: bearer-value", "bearer: [redacted secret]"],
  ["Cookie: session=cookie-value", "Cookie: [redacted secret]"],
  ["secret_key_base: base-value", "secret_key_base: [redacted secret]"],
  ["Password : spaced-value", "Password : [redacted secret]"],
  ["PASSWORD\t=\ttabbed-value", "PASSWORD\t=\t[redacted secret]"],
])("keeps the name of an assignment and removes its value: %s", (line, expected) => {
  expect(scrubReportText(`Before\n${line}\nAfter`)).toBe(`Before\n${expected}\nAfter`);
});

it("redacts a later secret on a line whose earlier label is ordinary", () => {
  expect(scrubReportText("ERROR: request failed with token=synthetic-value and retry")).toBe("ERROR: request failed with token=[redacted secret]");
});

it("removes a whole unquoted secret phrase, not only its first word", () => {
  expect(scrubReportText("db_password: correct horse battery")).toBe("db_password: [redacted secret]");
});

it.each([
  ["AKIAABCDEFGHIJKLMNOP is the key", "[redacted token] is the key"],
  ["glpat-abcdefghijklmnopqrst", "[redacted token]"],
  ["sk- abcdefghijklmnop", "[redacted token]"],
  ["BEARER abc.def", "[redacted authorization]"],
  ["{\\\"password\\\":\\\"hunter2-value\\\"}", "{\\\"password\\\":[redacted secret]"],
  ["Authorization: Token abcdef-value", "Authorization: [redacted secret]"],
  ["Authorization=Bearer abcdef-value", "Authorization=[redacted authorization]"],
])("removes a credential format: %s", (text, expected) => {
  expect(scrubReportText(text)).toBe(expected);
});

it("keeps relative paths and slash-separated words", () => {
  expect(scrubReportText("All user/provider content is omitted. See src/main/index.ts:42 and 200/300 runs.")).toBe("All user/provider content is omitted. See src/main/index.ts:42 and 200/300 runs.");
});

it.each([
  ["Opened /home/alice/notes (~/private/key) \"/etc/passwd\" path=/Users/bob/x", "Opened [private path] ([private path] \"[private path]\" path=[private path]"],
  ["../../Users/bob/project/x.ts", "..[private path]"],
  ["-/Users/bob/x", "-[private path]"],
  ["1C:\\Users\\bob\\x", "1[private path]"],
  ["x.C:\\Users\\bob", "x.[private path]"],
  ["C:/Users/bob/x", "[private path]"],
  ["C:\\Users\\Bob Smith\\Documents\\report.txt", "[private path]"],
  ["\"C:\\Users\\Bob Smith\\x.txt\" was opened", "\"[private path]\" was opened"],
  ["\\\\server\\share\\private folder", "[private path]"],
  ["file:///Users/bob/x", "[redacted URL]"],
  ["$HOME/project/x", "[private path]"],
  ["at foo (Users/bob/x.ts:1:1)", "at foo ([private path]"],
])("removes an absolute or home path: %s", (text, expected) => {
  expect(scrubReportText(text)).toBe(expected);
});

it.each([
  ["error at /Users/John Smith/secret-app/src/a.ts", "error at [private path]"],
  ["open /Users/eduard/Client Work/Acme Merger/plan.md", "open [private path]"],
  ["failed at /Users/John Smith/a.ts. Then it stopped", "failed at [private path] Then it stopped"],
  ["\"/Users/John Smith/a.ts\" was opened", "\"[private path]\" was opened"],
  ["~/My Projects/app/x.ts failed twice", "[private path] failed twice"],
  ["$HOME/My Projects/app failed", "[private path] failed"],
  ["at Users/John Smith/x.ts and src/main.ts", "at [private path] and src/main.ts"],
  ["see /tmp/a@example.com", "see [private path][redacted email]"],
])("removes a whole path with spaces and keeps the prose after it: %s", (text, expected) => {
  expect(scrubReportText(text)).toBe(expected);
});

it.each([
  ["git clone git@github.com:acme-private/secret-roadmap.git", "git clone [redacted URL]"],
  ["scp build eduard@devbox.corp.example:/srv/acme/secret now", "scp build [redacted URL] now"],
  ["key AIzaSyA1234567890abcdefghijklmnopqrstu", "key [redacted token]"],
  ["key npm_abcdefghijklmnopqrstuvwxyz0123456789", "key [redacted token]"],
  ["key hf_abcdefghijklmnopqrstuvwxyz01234", "key [redacted token]"],
])("removes an SSH remote or a known token format: %s", (text, expected) => {
  expect(scrubReportText(text)).toBe(expected);
});

it("keeps an email before a colon and words that only resemble token prefixes", () => {
  expect(scrubReportText("Ask bob@example.com: he saw it. Run npm-run-all, npm_config_cache and hf_hub.")).toBe("Ask [redacted email]: he saw it. Run npm-run-all, npm_config_cache and hf_hub.");
});

it("is idempotent", () => {
  const samples = [
    "Authorization=Bearer abcdef", "Authorization: Token abcdef", "{\"token\": \"abc\"}", "{\\\"password\\\":\\\"hunter\\\"}",
    "C:\\Users\\bob\\AppData\\x", "C:\\Users\\Bob Smith\\Documents", "file:///Users/bob/x", "~/.ssh/id_rsa", "../../Users/bob/project/x.ts",
    "at foo (Users/bob/x.ts:1:1)", "sk- abcdefghij", "GITHUB_PAT=0123", "NPM_AUTH=abc", "auth: abc", "X-Auth-Token: abc", "token:\n  abc",
    "AWS_SESSION=abc", "mail me at bob@example.com", "https://user:pass@host/x", "Cookie: session=abc", "-/Users/bob/x", "\\\\server\\share",
    "$HOME/x", "/home/bob", "TOKEN=abc ERROR: also", "apiKey=x", "access-token=x", "bearer: x", "glpat-abcdefghijklmnopqrst", "AKIAABCDEFGHIJKLMNOP",
    "Password : x", "PASSWORD\t=\tx", "{\"auth\":{\"token\":\"x\"}}", "token=\"x\\\" more\"", "C:/Users/bob/x", "x.C:\\Users\\bob", "1C:\\Users\\bob",
    "a=b token=c", "C:\\x y", "[redacted secret]: z", "key: [redacted token] tail", "~/a ~/b", "https://x y@z.com", "password=\"a\\\" b", "token='a' 'b'",
    `${"x".repeat(23_990)} ~/abc/def`,
  ];
  for (const sample of samples) {
    const once = scrubReportText(sample, 24_000);
    expect(scrubReportText(once, 24_000), sample).toBe(once);
  }
});

it("scrubbing twice gives the same result", () => {
  const samples = [
    "MY_SETTING=hunter2-value", "password: a b c", "{\"Token\":\"x\"}", "/Users/John Smith/x", "a@b.co/x/y",
    "see /tmp/a@example.com", "TOKEN=\"abc", "x=1 API_KEY=2", "Authorization: Bearer abc", "www.example.com/a?token=1",
    "C:\\x\\y z", "KEY= ", "SECRET=\n", "foo_TOKEN: [redacted", "sk- abc", "~/a b/c", "1. Run MY_VAR=1 npm start\n2. See /Users/a/b",
    "-----BEGIN RSA PRIVATE KEY-----\nabc", "path\\\\server\\share", "ghp_x@y.com", "\"api_key\" : 'v'", "a\u0001b", "  lead",
    "PASS=1\nPWD=/Users/x", "session-id=abc", "eyJa.b.c", "home/x", "x.Users/y", "eduard@devbox.example/home/eduard/acme",
  ];
  const unstable: Array<{ input: string; once: string; twice: string }> = [];
  for (const left of samples) {
    for (const right of ["", " ", "\n", ...samples]) {
      const input = `${left}${right ? ` ${right}` : ""}`;
      const once = scrubReportText(input);
      const twice = scrubReportText(once);
      if (once !== twice) unstable.push({ input, once, twice });
    }
  }
  expect(unstable).toEqual([]);
});

it("accepts exactly the providers the command contracts accept", () => {
  expect([...REPORT_PROVIDER_IDS].sort()).toEqual([...providerIdSchema.options].sort());
});

it.each(["a.", "a-", "a_", "a.b-c+d_", "a@b.", "x-y=", "ab.cd-ef:"])("scrubs a full body of repeated %j in linear time and stays stable", (unit) => {
  const text = unit.repeat(Math.ceil(REPORT_BODY_LIMIT / unit.length)).slice(0, REPORT_BODY_LIMIT);
  const started = performance.now();
  const scrubbed = scrubReportText(text, REPORT_BODY_LIMIT);
  expect(performance.now() - started).toBeLessThan(100);
  expect(scrubReportText(scrubbed, REPORT_BODY_LIMIT)).toBe(scrubbed);
});

it.each([
  ["1-SECRET=abc", "1-SECRET=[redacted secret]"],
  ["9a-TOKEN=abc", "9a-TOKEN=[redacted secret]"],
  ["x git@github.com:org/repo.git y", "x [redacted URL] y"],
  ["mail me@example.com now", "mail [redacted email] now"],
  ["see https://a.b/c", "see [redacted URL]"],
])("keeps redacting %j", (input, expected) => {
  expect(scrubReportText(input)).toBe(expected);
});

