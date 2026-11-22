import type { IPty, spawn } from "node-pty";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const LOOKUP_KEY = "NoDefaultCurrentDirectoryInExePath";

function fakePty(): IPty {
  const disposable = { dispose: vi.fn() };
  return {
    pid: 42,
    onData: vi.fn(() => disposable),
    onExit: vi.fn(() => disposable),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  } as unknown as IPty;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("integrated terminal executable lookup environment", () => {
  it.each([undefined, "", "user"])(
    "starts the user's Windows shell with the user's own setting (%j) while the runtime stays guarded",
    async (userSetting) => {
      vi.resetModules();
      vi.stubEnv(LOOKUP_KEY, userSetting);
      const guard = await import("../../src/node/windows-current-directory-search");
      guard.guardProcessAgainstWindowsCurrentDirectorySearch(process.env, "win32");
      expect(process.env[LOOKUP_KEY]).toBe("1");
      const { TerminalManager } = await import("../../src/server/terminal");
      const owner = { readyState: 1, bufferedAmount: 0, send: vi.fn() } as unknown as WebSocket;
      const spawnTerminal = vi.fn<(...args: Parameters<typeof spawn>) => IPty>(() => fakePty());
      const manager = new TerminalManager({ spawnTerminal, platform: "win32" });

      manager.create(owner, process.cwd(), 80, 24);
      manager.createProcess(owner, process.cwd(), "C:\\Tools\\provider.exe", [], { [LOOKUP_KEY]: "1" }, 80, 24);

      const [shellEnvironment, providerEnvironment] = spawnTerminal.mock.calls.map(([, , options]) => options?.env ?? {});
      expect(Object.entries(shellEnvironment!).filter(([key]) => key.toUpperCase() === LOOKUP_KEY.toUpperCase()))
        .toEqual(userSetting === undefined ? [] : [[LOOKUP_KEY, userSetting]]);
      expect(providerEnvironment![LOOKUP_KEY]).toBe("1");
      expect(process.env[LOOKUP_KEY]).toBe("1");
    },
  );
});
