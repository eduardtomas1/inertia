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
    ["export API_TOKEN=\"first-half\nsecond-half-of-secret\"", "export API_TOKEN=[redacted]"],
    ["export API_TOKEN=\"first-half\nsecond-half-of-secret", "export API_TOKEN=[redacted]"],
  ])("redacts the value of a secret-named assignment in %j", (command, scrubbed) => {
    expect(scrubCommandSecrets(command)).toBe(scrubbed);
    expect(scrubCommandSecrets(scrubbed)).toBe(scrubbed);
  });

  it.each([
    ["mysql -u root --password hunter2 -h db", "mysql -u root --password [redacted] -h db"],
    ["gh auth login --token abcdefg123", "gh auth login --token [redacted]"],
    ["vault write --secret s3cr3t", "vault write --secret [redacted]"],
    ["tool --api-key abc123 --db-password=hunter2", "tool --api-key [redacted] --db-password=[redacted]"],
    ["tool --password \"two words\" run", "tool --password [redacted] run"],
    ["mysql -u root -phunter2 -h db", "mysql -u root -p[redacted] -h db"],
    ["docker login -p hunter2 registry", "docker login -p [redacted] registry"],
    ["curl -u admin:s3cretpw https://x", "curl -u admin:[redacted] https://x"],
    ["curl --user 'user:pass word' https://x", "curl --user 'user:[redacted]' https://x"],
    ["aws configure set aws_secret_access_key ABCDEFxyz", "aws configure set aws_secret_access_key [redacted]"],
    ["curl -H \"Authorization: token abcdef123456\" https://x", "curl -H \"Authorization: [redacted]\" https://x"],
    ["curl -H \"X-Api-Key: abcdef123456\" https://x", "curl -H \"X-Api-Key: [redacted]\" https://x"],
    ["gh secret set DEPLOY_KEY --body hunter2 --repo o/r", "gh secret set DEPLOY_KEY --body [redacted] --repo o/r"],
    ["gh secret set DEPLOY_KEY --body=hunter2", "gh secret set DEPLOY_KEY --body=[redacted]"],
    ["gh secret set NAME -b \"two words\"", "gh secret set NAME -b [redacted]"],
  ])("redacts the credential in the command %j", (command, scrubbed) => {
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
    "mkdir -p src/lib && ssh -p 2222 host",
    "curl -u admin https://x",
    "docker login --password-stdin registry",
    "mysql -u root -P 3306 -p",
    "gh pr create --title Fix --body \"Ready for review\"",
  ])("leaves the ordinary command %j intact", (command) => {
    expect(scrubCommandSecrets(command)).toBe(command);
  });
});
