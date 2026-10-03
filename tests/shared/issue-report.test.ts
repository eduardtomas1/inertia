import { expect, it } from "vitest";
import { providerIdSchema } from "../../src/shared/contracts/client-command/common";
import { REPORT_PROVIDER_IDS, scrubReportText } from "../../src/shared/issue-report";

it.each([
  "ENOENT: no such file or directory, open 'config.json'",
  "ERROR: the turn stopped after cancellation",
  "HTTP: 500 Internal Server Error",
  "WARN=retrying the provider request",
  "PASSED: 3 tests",
])("keeps an ordinary diagnostic line: %s", (line) => {
  expect(scrubReportText(`The chat stopped.\n${line}\nThen nothing happened.`)).toBe(`The chat stopped.\n${line}\nThen nothing happened.`);
});

it.each([
  ["AUTH_KEY=never-copy", "never-copy"],
  ["OPENAI_API_KEY=sk_live-value", "sk_live-value"],
  ["GITHUB_TOKEN: synthetic-token-value", "synthetic-token-value"],
  ["AWS_SECRET_ACCESS_KEY = synthetic+secret-value", "synthetic+secret-value"],
  ["DB_PASSWORD='quoted value'", "quoted value"],
  ["SESSION_COOKIE=\"cookie value\"", "cookie value"],
  ["password: hidden", "hidden"],
  ["api_key = plain", "plain"],
])("removes the value of a secret assignment but keeps its line: %s", (line, secret) => {
  const clean = scrubReportText(`Before\n${line}\nAfter`);
  expect(clean).not.toContain(secret);
  expect(clean).toMatch(/^Before\n.*\[redacted (?:secret|token)\]\nAfter$/u);
});

it("redacts a later secret on a line whose earlier label is ordinary", () => {
  const clean = scrubReportText("ERROR: request failed with token=synthetic-value and retry");
  expect(clean).toBe("ERROR: request failed with [redacted secret]");
});

it("removes a whole unquoted secret phrase, not only its first word", () => {
  expect(scrubReportText("db_password: correct horse battery")).toBe("[redacted secret]");
});

it("accepts exactly the providers the command contracts accept", () => {
  expect([...REPORT_PROVIDER_IDS].sort()).toEqual([...providerIdSchema.options].sort());
});
