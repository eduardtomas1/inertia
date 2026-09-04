import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GeminiAcpSecretRedactor,
  geminiDotenvSecretValues,
} from "../../src/server/provider/gemini-acp-redaction";
import { geminiErrorDetail } from
  "../../src/server/provider/gemini-acp-support";
import { CappedProviderBuffer } from "../../src/server/provider/io";

const fixtureRoots: string[] = [];

describe.sequential("Gemini dotenv credential inventory", () => {
  afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers workspace ancestors and configured home without classifying ordinary values", async () => {
    const root = fixtureRoot("candidates");
    const cwd = join(root, "workspace", "package");
    const configuredHome = join(root, "configured-home");
    const defaultHome = join(root, "default-home");
    mkdirSync(join(root, ".gemini"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(configuredHome, ".gemini"), { recursive: true });
    mkdirSync(defaultHome, { recursive: true });
    writeFileSync(join(root, ".env"), [
      "GEMINI_API_KEY='raw$ project secret'",
      "NODE_ENV=production",
      "GOOGLE_CLOUD_PROJECT=public-project",
      "GOOGLE_APPLICATION_CREDENTIALS=/credential/path.json",
      "DUPLICATE_TOKEN=stale-token",
      "DUPLICATE_TOKEN=`current-token`",
      "MULTILINE_SECRET=\"line\\nsecret\"",
    ].join("\n"));
    writeFileSync(
      join(root, ".gemini", ".env"),
      "GEMINI_CLI_CUSTOM_HEADERS=X-Trace: trace-value, X-Service-Key: service-value\n",
    );
    writeFileSync(
      join(configuredHome, ".gemini", ".env"),
      "HOME_ACCESS_TOKEN=home-token\n",
    );
    writeFileSync(
      join(defaultHome, ".env"),
      "DEFAULT_HOME_SECRET=default-home-secret\n",
    );

    const secrets = await geminiDotenvSecretValues(cwd, {
      GEMINI_CLI_HOME: configuredHome,
      HOME: defaultHome,
    });

    expect(secrets).toEqual(expect.arrayContaining([
      "raw$ project secret",
      "rawprojectsecret",
      "current-token",
      "line\nsecret",
      "X-Trace: trace-value, X-Service-Key: service-value",
      "trace-value",
      "service-value",
      "home-token",
      "default-home-secret",
    ]));
    expect(secrets).not.toEqual(expect.arrayContaining([
      "stale-token",
      "production",
      "public-project",
      "/credential/path.json",
    ]));
  });

  it("honors inherited own-property precedence with platform key semantics", async () => {
    const root = fixtureRoot("precedence");
    writeFileSync(join(root, ".env"), "SERVICE_TOKEN=file-token\n");

    await expect(geminiDotenvSecretValues(
      root,
      { SERVICE_TOKEN: "inherited-token" },
      { platform: "linux" },
    )).resolves.not.toContain("file-token");
    await expect(geminiDotenvSecretValues(
      root,
      { service_token: "inherited-token" },
      { platform: "linux" },
    )).resolves.toContain("file-token");
    await expect(geminiDotenvSecretValues(
      root,
      { service_token: "inherited-token" },
      { platform: "win32" },
    )).resolves.not.toContain("file-token");
  });

  it("fails closed for non-regular and oversized candidates", async () => {
    const directoryRoot = fixtureRoot("directory");
    mkdirSync(join(directoryRoot, ".env"));
    await expect(geminiDotenvSecretValues(directoryRoot, {})).rejects.toThrow(
      /unsafe candidate/iu,
    );

    const oversizedRoot = fixtureRoot("oversized");
    const oversized = join(oversizedRoot, ".env");
    writeFileSync(oversized, "GEMINI_API_KEY=x\n");
    truncateSync(oversized, 256 * 1024 + 1);
    await expect(geminiDotenvSecretValues(oversizedRoot, {})).rejects.toThrow(
      /unsafe candidate/iu,
    );
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlink candidates",
    async () => {
      const root = fixtureRoot("symlink");
      const target = join(root, "target");
      writeFileSync(target, "GEMINI_API_KEY=linked-secret\n");
      symlinkSync(target, join(root, ".env"));

      await expect(geminiDotenvSecretValues(root, {})).rejects.toThrow(
        /unsafe candidate/iu,
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "searches the physical workspace ancestors used by the child process",
    async () => {
      const root = fixtureRoot("symlink-cwd");
      const physical = join(root, "physical");
      const nested = join(physical, "nested");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(physical, ".env"), "SERVICE_TOKEN=physical-token\n");
      const alias = join(root, "alias");
      symlinkSync(physical, alias);

      await expect(geminiDotenvSecretValues(
        join(alias, "nested"),
        {},
      )).resolves.toContain("physical-token");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO candidate without opening or blocking on it",
    async () => {
      const root = fixtureRoot("fifo");
      const fifo = join(root, ".env");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

      await expect(geminiDotenvSecretValues(root, {})).rejects.toThrow(
        /unsafe candidate/iu,
      );
    },
  );
});

describe("Gemini diagnostic stream redaction", () => {
  it("redacts a credential split where a raw cap would retain its prefix", () => {
    const secret = "split-secret-value";
    const split = 9;
    const redactor = new GeminiAcpSecretRedactor({ GEMINI_API_KEY: secret });
    const capped = new CappedProviderBuffer(12);

    capped.append(redactor.stderrChunk(`safe:${secret.slice(0, split)}`));
    capped.append(redactor.stderrChunk(secret.slice(split)));
    capped.append(redactor.finishStderr());

    expect(capped.toString()).toContain("safe:");
    expect(capped.toString()).toContain("[redac");
    expect(capped.toString()).not.toContain(secret.slice(0, split));
    expect(capped.toString()).not.toContain(secret);
  });

  it("does not flush a terminal credential prefix into diagnostics", () => {
    const secret = "terminal-secret-value";
    const prefix = secret.slice(0, 11);
    const redactor = new GeminiAcpSecretRedactor({ GEMINI_API_KEY: secret });

    const output = redactor.stderrChunk(`diagnostic:${prefix}`)
      + redactor.finishStderr();

    expect(output).toBe("diagnostic:[redacted]");
    expect(output).not.toContain(prefix);
  });

  it("redacts error details before their bounded prefix is selected", () => {
    const secret = "error-cap-boundary-secret";
    const visiblePrefixLength = 16;
    const redactor = new GeminiAcpSecretRedactor({ GEMINI_API_KEY: secret });
    const error = new Error(
      "x".repeat(1024 * 1024 - visiblePrefixLength)
      + secret,
    );

    const detail = geminiErrorDetail(
      error,
      "fallback",
      (value) => redactor.payload(value),
    );

    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain(secret);
    expect(detail).not.toContain(secret.slice(0, visiblePrefixLength));
  });
});

function fixtureRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `inertia-gemini-dotenv-${label}-`));
  fixtureRoots.push(root);
  return root;
}
