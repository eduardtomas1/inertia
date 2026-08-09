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
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      GH_CONFIG_DIR: "/Users/test/.config/custom-gh",
      XDG_CONFIG_HOME: "/Users/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HTTP_PROXY: "http://proxy.example:8080",
      https_proxy: "http://secure-proxy.example:8443",
      NO_PROXY: "127.0.0.1,localhost",
      SSL_CERT_FILE: "/Users/test/.config/company-ca.pem",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      SENTINEL_SECRET: "secret",
    }, "darwin")).toEqual({
      NO_COLOR: "1",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      GH_CONFIG_DIR: "/Users/test/.config/custom-gh",
      HOME: "/Users/test",
      HTTP_PROXY: "http://proxy.example:8080",
      NO_PROXY: "127.0.0.1,localhost",
      PATH: "/usr/bin",
      SSL_CERT_FILE: "/Users/test/.config/company-ca.pem",
      XDG_CONFIG_HOME: "/Users/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      https_proxy: "http://secure-proxy.example:8443",
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
