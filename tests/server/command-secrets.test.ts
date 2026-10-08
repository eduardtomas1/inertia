import { describe, expect, it } from "vitest";

import { scrubCommandSecrets } from "../../src/server/provider/command-secrets";

describe("scrubCommandSecrets", () => {
  it.each([
    ["PGPASSWORD=hunter2 psql -h db.internal -U admin", "PGPASSWORD=[redacted] psql -h db.internal -U admin"],
    ["export DB_Secret='two words' && run", "export DB_Secret=[redacted] && run"],
    ["GITHUB_TOKEN=\"abc def\" gh pr list", "GITHUB_TOKEN=[redacted] gh pr list"],
    ["stripe_key=live123;deploy", "stripe_key=[redacted];deploy"],
    ["env AWS_CREDENTIALS=/tmp/c npm test", "env AWS_CREDENTIALS=[redacted] npm test"],
    ["mysql --password=hunter2 -u root", "mysql --password=[redacted] -u root"],
  ])("redacts the value of a secret-named assignment in %j", (command, scrubbed) => {
    expect(scrubCommandSecrets(command)).toBe(scrubbed);
    expect(scrubCommandSecrets(scrubbed)).toBe(scrubbed);
  });

  it("still applies the shared secret patterns", () => {
    expect(scrubCommandSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop' https://x")).not.toContain("abcdefghijklmnop");
  });

  it.each([
    "npm test -- --grep \"retry policy\"",
    "NODE_ENV=test npm run build",
    "git commit -m \"Fix the token parser\"",
    "psql -h db.internal -U admin -c 'select 1'",
    "grep -r PASSWORD src | wc -l",
  ])("leaves the ordinary command %j intact", (command) => {
    expect(scrubCommandSecrets(command)).toBe(command);
  });
});
