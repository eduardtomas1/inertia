import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

import { providerAuthBrowserUrlFromTerminal } from "../../src/renderer/src/utils/providerAuthBrowser";

const AUTH_URL = "https://claude.com/cai/oauth/authorize?client_id=fixture&response_type=code&state=fixture-state&code_challenge=fixture-challenge";
const terminals: Terminal[] = [];

function fixture(cols = 40) {
  // Exercise the installed terminal parser, without a browser or native PTY.
  const terminal = new Terminal({ cols, rows: 10, allowProposedApi: false });
  terminals.push(terminal);
  return {
    terminal,
    async write(data: string): Promise<string | null> {
      await new Promise<void>((resolve) => terminal.write(data, resolve));
      return providerAuthBrowserUrlFromTerminal("claude", terminal);
    },
  };
}

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

describe("provider sign-in links in the parsed terminal", () => {
  it("reassembles a soft-wrapped URL interrupted by cursor visibility and style controls", async () => {
    const auth = fixture();
    const split = AUTH_URL.indexOf("orize?");
    expect(await auth.write(`Open: ${AUTH_URL.slice(0, split)}\x1b[?25h`)).toBeNull();
    expect(await auth.write(`\x1b[?25l\x1b[0m${AUTH_URL.slice(split)}\r\n`)).toBe(AUTH_URL);
  });

  it("does not mistake a split control or query for a completed URL", async () => {
    const auth = fixture();
    const split = AUTH_URL.indexOf("&code_challenge");
    expect(await auth.write(AUTH_URL.slice(0, split))).toBeNull();
    expect(await auth.write("\x1b[")).toBeNull();
    expect(await auth.write(`0m${AUTH_URL.slice(split)}`)).toBeNull();
    expect(await auth.write("\r\n")).toBe(AUTH_URL);
  });

  it("uses the parser's cursor position when a continuation redraws at the same location", async () => {
    const auth = fixture(90);
    const split = AUTH_URL.indexOf("orize?");
    expect(await auth.write(AUTH_URL.slice(0, split))).toBeNull();
    const buffer = auth.terminal.buffer.active;
    const position = `\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`;
    expect(await auth.write(`${position}${AUTH_URL.slice(split)}\r\n`)).toBe(AUTH_URL);
  });

  it("does not treat unused screen padding as a URL delimiter", async () => {
    const auth = fixture(200);
    expect(await auth.write(AUTH_URL)).toBeNull();
    expect(await auth.write(" ")).toBe(AUTH_URL);
  });

  it("does not concatenate distinct hard lines into an allowed endpoint", async () => {
    const auth = fixture();
    expect(await auth.write("https://claude.com/cai/oauth/auth\r\n")).toBeNull();
    expect(await auth.write("orize?state=fixture\r\n")).toBeNull();
  });

  it("ignores official-looking URLs in an invisible OSC window title", async () => {
    const auth = fixture();
    expect(await auth.write(`\x1b]0;${AUTH_URL}\x07Visible sign-in instructions\r\n`)).toBeNull();
  });

  it("ignores an OSC hyperlink target that is not printed in the terminal", async () => {
    const auth = fixture();
    expect(await auth.write(`\x1b]8;;${AUTH_URL}\x07click here\x1b]8;;\x07\r\n`)).toBeNull();
  });

  it("preserves written spaces on soft-wrapped lines instead of joining tokens", async () => {
    const auth = fixture(40);
    const prefix = "https://claude.com/cai/oauth/auth";
    expect(await auth.write(prefix + " ".repeat(40 - prefix.length))).toBeNull();
    expect(await auth.write("orize?state=fixture\r\n")).toBeNull();
  });

  it("does not reuse text erased by a terminal reset", async () => {
    const auth = fixture();
    expect(await auth.write(AUTH_URL.slice(0, -10))).toBeNull();
    expect(await auth.write(`\x1bc${AUTH_URL.slice(-10)}\r\n`)).toBeNull();
  });

  it("rejects oversized links and accepts a later bounded official link", async () => {
    const auth = fixture();
    expect(await auth.write(`https://claude.com/cai/oauth/authorize?state=${"x".repeat(8_192)}\r\n`)).toBeNull();
    expect(await auth.write(`${AUTH_URL}\r\n`)).toBe(AUTH_URL);
  });
});
