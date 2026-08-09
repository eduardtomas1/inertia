import { describe, expect, it } from "vitest";

import {
  restrictedCliEnvironment,
  runRestrictedCli,
} from "../../src/server/restricted-cli-runner";

describe("restricted CLI runner", () => {
  it("keeps OS/config paths while stripping ambient credentials and secrets", () => {
    expect(restrictedCliEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      GH_CONFIG_DIR: "/Users/test/.config/custom-gh",
      XDG_CONFIG_HOME: "/Users/test/.config",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      SENTINEL_SECRET: "secret",
    }, "darwin")).toEqual({
      NO_COLOR: "1",
      GH_CONFIG_DIR: "/Users/test/.config/custom-gh",
      HOME: "/Users/test",
      PATH: "/usr/bin",
      XDG_CONFIG_HOME: "/Users/test/.config",
    });
  });

  it("passes bounded stdin without a shell and never restores stripped variables", async () => {
    const result = await runRestrictedCli(
      process.execPath,
      [
        "-e",
        "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input,sentinel:process.env.SENTINEL_SECRET??null})))",
      ],
      {
        cwd: process.cwd(),
        environment: {
          PATH: process.env.PATH,
          SENTINEL_SECRET: "must-not-cross",
        },
        input: "private body over stdin",
        failureMessage: "Fixture failed.",
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      input: "private body over stdin",
      sentinel: null,
    });
    expect(result.stderr).toBe("");
  });
});
