import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { registerInertiaReleaseIpc } from "../../src/main/inertia-release-ipc";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => unknown;

function fakeIpcMain(): {
  ipcMain: IpcMain;
  handlers: Map<string, InvokeHandler>;
} {
  const handlers = new Map<string, InvokeHandler>();
  return {
    ipcMain: {
      handle: (channel: string, handler: InvokeHandler) => {
        handlers.set(channel, handler);
      },
    } as unknown as IpcMain,
    handlers,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Inertia release IPC", () => {
  it("posts only authoritative releases fetched by the privileged handler", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const resolve = vi.fn(async () =>
      "https://discord.com/api/webhooks/123/token");
    const assertTrusted = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/releases?")) {
        return jsonResponse([{
          tag_name: "v0.0.41",
          name: "Authoritative Inertia 0.0.41",
          created_at: "2030-01-03T03:04:05.000Z",
        }, {
          tag_name: "v0.0.40",
          name: "Authoritative Inertia 0.0.40",
          created_at: "2030-01-02T03:04:05.000Z",
        }]);
      }
      if (url.includes("/compare/")) {
        return jsonResponse({ commits: [], files: [] });
      }
      expect(url).toBe("https://discord.com/api/webhooks/123/token");
      const body = JSON.parse(String(init?.body)) as { content: string };
      expect(body.content).toBe("**Authoritative Inertia 0.0.41**");
      expect(body.content).not.toContain("Spoofed");
      return new Response(null, { status: 204 });
    });
    registerInertiaReleaseIpc(
      ipcMain,
      fetch,
      () => ({ resolve }),
      assertTrusted,
    );

    const handler = handlers.get("inertia:send-discord-release-info");
    expect(handler).toBeDefined();
    await expect(handler?.({} as IpcMainInvokeEvent, {
      repositoryUrl: "https://github.com/eduardtomas1/inertia",
      release: { tag: "v9.9.9", name: "Spoofed release" },
      previousRelease: { tag: "v9.9.8", name: "Spoofed previous release" },
    })).resolves.toEqual({ sent: true });
    expect(assertTrusted).toHaveBeenCalledWith(expect.anything(), 1, 1);
    expect(resolve).toHaveBeenCalledWith(expect.stringMatching(/^secret:backend:/u));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid repositories before resolving the webhook secret", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const resolve = vi.fn(async () =>
      "https://discord.com/api/webhooks/123/token");
    const fetch = vi.fn<typeof globalThis.fetch>();
    registerInertiaReleaseIpc(
      ipcMain,
      fetch,
      () => ({ resolve }),
      vi.fn(),
    );

    const handler = handlers.get("inertia:send-discord-release-info");
    await expect(handler?.({} as IpcMainInvokeEvent, {
      repositoryUrl: "",
    })).rejects.toThrow(
      "release repository URL is required",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when secure credential storage is unavailable", async () => {
    const { ipcMain, handlers } = fakeIpcMain();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/releases?")) {
        return jsonResponse([{
          tag_name: "v0.0.41",
          name: "Inertia 0.0.41",
          created_at: "2030-01-03T03:04:05.000Z",
        }, {
          tag_name: "v0.0.40",
          name: "Inertia 0.0.40",
          created_at: "2030-01-02T03:04:05.000Z",
        }]);
      }
      if (url.includes("/compare/")) {
        return jsonResponse({ commits: [], files: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    registerInertiaReleaseIpc(ipcMain, fetch, () => null, vi.fn());

    const handler = handlers.get("inertia:send-discord-release-info");
    await expect(handler?.({} as IpcMainInvokeEvent, {
      repositoryUrl: "https://github.com/eduardtomas1/inertia",
    })).rejects.toThrow("Secure credential storage is unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
