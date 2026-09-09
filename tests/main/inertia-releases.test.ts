import { describe, expect, it, vi } from "vitest";

import {
  listInertiaReleases,
  sendDiscordReleaseInfo,
} from "../../src/main/inertia-releases";

function jsonResponse(value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("Inertia release list", () => {
  it("loads a bounded GitHub release page and returns sanitized releases by creation date", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json, application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Inertia",
        },
      });
      return jsonResponse([
        {
          tag_name: "v0.0.40",
          name: "Inertia 0.0.40",
          html_url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.40",
          created_at: "2030-01-02T03:04:05.000Z",
          published_at: "2030-01-02T04:04:05.000Z",
          body: "Release notes",
        },
        {
          tag_name: "v0.0.41",
          name: "Inertia 0.0.41",
          html_url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.41",
          created_at: "2030-01-03T03:04:05.000Z",
          published_at: "2030-01-03T04:04:05.000Z",
          body: "Newer release notes",
        },
        {
          tag_name: "",
          created_at: "2030-01-04T03:04:05.000Z",
        },
      ]);
    });

    await expect(listInertiaReleases(fetch, {
      repositoryUrl: "https://github.com/eduardtomas1/inertia",
    })).resolves.toEqual([
      {
        tag: "v0.0.41",
        name: "Inertia 0.0.41",
        url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.41",
        createdAt: "2030-01-03T03:04:05.000Z",
        releasedAt: "2030-01-03T04:04:05.000Z",
        description: "Newer release notes",
      },
      {
        tag: "v0.0.40",
        name: "Inertia 0.0.40",
        url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.40",
        createdAt: "2030-01-02T03:04:05.000Z",
        releasedAt: "2030-01-02T04:04:05.000Z",
        description: "Release notes",
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/eduardtomas1/inertia/releases?per_page=10",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects oversized release responses before parsing", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse([], { "Content-Length": `${1_024 * 1_024 + 1}` }));

    await expect(listInertiaReleases(fetch, {
      repositoryUrl: "https://github.com/eduardtomas1/inertia",
    })).rejects.toThrow(
      "release response was too large",
    );
  });

  it("rejects missing release repository URLs without calling fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(listInertiaReleases(fetch, {
      repositoryUrl: "",
    })).rejects.toThrow("release repository URL is required");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Discord release info", () => {
  const request = {
    repositoryUrl: "https://github.com/example/project",
    previousRelease: { tag: "v1", name: null, url: null, createdAt: "2026-01-01T00:00:00Z", releasedAt: null, description: null },
    release: { tag: "v2", name: null, url: null, createdAt: "2026-01-02T00:00:00Z", releasedAt: null, description: "Real published notes, not inferred from filenames." },
  };

  it("cancels an oversized compare stream and delivers an explicitly limited, real release-notes preview", async () => {
    const cancel = vi.fn();
    let count = 0;
    const posts: Record<string, unknown>[] = [];
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      if (init?.method === "GET") return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(256 * 1_024)); count++; }, cancel,
      }));
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ id: "1234" });
    });
    await expect(sendDiscordReleaseInfo(fetch, "https://discord.com/api/webhooks/123/token", request))
      .resolves.toEqual({ sent: true, comparisonLimited: true });
    expect(cancel).toHaveBeenCalledOnce(); expect(count).toBeLessThanOrEqual(6);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts[0])).toContain(request.release.description);
    expect(JSON.stringify(posts[0])).toContain("Comparativa limitada");
    expect(JSON.stringify(posts[0])).not.toContain("Sense canvis detectats");
    expect(signals[0]).not.toBe(signals[1]);
  });

  it.each([204, 500])("treats an unconfirmed HTTP %s delivery as unknown without resending", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => init?.method === "GET"
      ? jsonResponse({ commits: [] }) : new Response(null, { status }));
    await expect(sendDiscordReleaseInfo(fetch, "https://discord.com/api/webhooks/123/token", request))
      .rejects.toMatchObject({ code: "discord.delivery-unknown" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not send when comparison preparation fails, and does not infer release descriptions from unrelated file paths", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ message: "PRIVATE_SERVER_OUTPUT" }, { }));
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(sendDiscordReleaseInfo(fetch, "https://discord.com/api/webhooks/123/token", request))
      .rejects.toMatchObject({ code: "discord.release-fetch-failed", httpStatus: 403 });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("sends the selected release to a Discord webhook", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).includes("/compare/")) {
        return jsonResponse({
          html_url: "https://github.com/eduardtomas1/inertia/compare/v0.0.40...v0.0.41",
          commits: [{
            commit: { message: "Fix Discord webhook payload validation" },
          }, {
            commit: { message: "Add release settings UI" },
          }, {
            commit: { message: "Improve release popup layout" },
          }],
          files: [{
            filename: "src/renderer/src/components/SettingsView.tsx",
            status: "modified",
            patch: "discord release settings",
          }],
        });
      }
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Inertia",
        },
      });
      const body = JSON.parse(String(init?.body));
      expect(body.content).toBe("**Inertia 0.0.41**");
      expect(body.allowed_mentions).toEqual({ parse: [] });
      expect(body.embeds[0]).toMatchObject({
        title: "Comparativa v0.0.40 -> v0.0.41",
        url: "https://github.com/eduardtomas1/inertia/compare/v0.0.40...v0.0.41",
      });
      expect(body.embeds[0].description).toBe("Release notes");
      expect(body.embeds[0].fields).toEqual([{
        name: "Commits · vista prèvia", inline: false,
        value: "- Fix Discord webhook payload validation\n- Add release settings UI\n- Improve release popup layout",
      }]);
      expect(JSON.stringify(body)).not.toContain("Millorada la configuració");
      return jsonResponse({ id: "123456789" });
    });

    await expect(sendDiscordReleaseInfo(
      fetch,
      "https://discord.com/api/webhooks/123/token",
      {
        repositoryUrl: "https://github.com/eduardtomas1/inertia",
        previousRelease: {
          tag: "v0.0.40",
          name: "Inertia 0.0.40",
          url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.40",
          createdAt: "2030-01-02T03:04:05.000Z",
          releasedAt: "2030-01-02T04:04:05.000Z",
          description: "Previous release notes",
        },
        release: {
          tag: "v0.0.41",
          name: "Inertia 0.0.41",
          url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.41",
          createdAt: "2030-01-03T03:04:05.000Z",
          releasedAt: "2030-01-03T04:04:05.000Z",
          description: "Release notes",
        },
      },
    )).resolves.toEqual({ sent: true, comparisonLimited: false });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/eduardtomas1/inertia/compare/v0.0.40...v0.0.41",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://discord.com/api/webhooks/123/token?wait=true",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("accepts the normalized release shape selected by the renderer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).includes("/compare/")
        ? jsonResponse({ commits: [], files: [] })
        : jsonResponse({ id: "123456789" }));

    await expect(sendDiscordReleaseInfo(
      fetch,
      "https://discord.com/api/webhooks/123/token",
      {
        repositoryUrl: "https://github.com/eduardtomas1/inertia",
        previousRelease: {
          tag: "v0.0.40",
          name: "Inertia 0.0.40",
          url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.40",
          createdAt: "2030-01-02T03:04:05.000Z",
          releasedAt: "2030-01-02T04:04:05.000Z",
          description: "Previous release notes",
        },
        release: {
          tag: "v0.0.41",
          name: "Inertia 0.0.41",
          url: "https://github.com/eduardtomas1/inertia/releases/tag/v0.0.41",
          createdAt: "2030-01-03T03:04:05.000Z",
          releasedAt: "2030-01-03T04:04:05.000Z",
          description: "Release notes",
        },
      },
    )).resolves.toEqual({ sent: true, comparisonLimited: false });

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects non-Discord webhook URLs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(sendDiscordReleaseInfo(
      fetch,
      "https://example.com/api/webhooks/123/token",
      {
        repositoryUrl: "https://github.com/eduardtomas1/inertia",
        previousRelease: {
          tag: "v0.0.40",
          name: "Inertia 0.0.40",
          url: null,
          createdAt: "2030-01-02T03:04:05.000Z",
          releasedAt: null,
          description: null,
        },
        release: {
          tag: "v0.0.41",
          name: "Inertia 0.0.41",
          url: null,
          createdAt: "2030-01-03T03:04:05.000Z",
          releasedAt: null,
          description: null,
        },
      },
    )).rejects.toMatchObject({ code: "discord.webhook-missing" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
