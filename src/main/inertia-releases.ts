import type {
  InertiaReleaseInfo,
  SendDiscordReleaseInfoRequest,
} from "../shared/desktop.js";
import type { DiagnosticCode } from "../shared/application-diagnostics.js";

export class ReleaseOperationError extends Error {
  constructor(readonly code: DiagnosticCode, message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "ReleaseOperationError";
  }
}
class ReleaseResponseTooLarge extends Error {
  constructor() { super("The release response was too large."); }
}

const MAX_RELEASE_RESPONSE_BYTES = 1_024 * 1_024;
const RELEASE_FETCH_TIMEOUT_MS = 10_000;
const DISCORD_WEBHOOK_TIMEOUT_MS = 10_000;
const DISCORD_FIELD_LIMIT = 1_024;
const DISCORD_DESCRIPTION_LIMIT = 4_096;

type RepositoryDescriptor =
  | {
    provider: "github";
    releasesUrl: string;
    compareUrl(base: string, head: string): string;
    compareWebUrl(base: string, head: string): string;
  }
  | {
    provider: "gitlab";
    releasesUrl: string;
    compareUrl(base: string, head: string): string;
    compareWebUrl(base: string, head: string): string;
  };

interface ReleaseCompare {
  url: string;
  commits: string[];
  limited: boolean;
}

function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum) return null;
  return trimmed;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength)
    && declaredLength > MAX_RELEASE_RESPONSE_BYTES
  ) {
    await response.body?.cancel();
    throw new ReleaseResponseTooLarge();
  }
  if (!response.body) throw new Error("The release response was empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RELEASE_RESPONSE_BYTES) {
        await reader.cancel("The release response was too large.");
        throw new ReleaseResponseTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function normalizedRepositoryUrl(value: unknown): URL {
  const repositoryUrl = boundedString(value, 500);
  if (!repositoryUrl) throw new Error("A release repository URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    throw new Error("The release repository URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw new Error("The release repository URL must use HTTPS.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\.git$/u, "").replace(/\/+$/u, "");
  return parsed;
}

export function validateReleaseRepository(value: unknown): void {
  try { repositoryDescriptor(value); }
  catch { throw new ReleaseOperationError("discord.repository-missing", "A supported public release repository URL is required."); }
}

function repositoryDescriptor(value: unknown): RepositoryDescriptor {
  const repository = normalizedRepositoryUrl(value);
  const segments = repository.pathname.split("/").filter(Boolean);
  if (repository.hostname.toLowerCase() === "github.com" && segments.length >= 2) {
    const [owner, repo] = segments;
    const apiRepository = `${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}`;
    const webRepository = `https://github.com/${owner!}/${repo!}`;
    return {
      provider: "github",
      releasesUrl: `https://api.github.com/repos/${apiRepository}/releases?per_page=10`,
      compareUrl: (base, head) =>
        `https://api.github.com/repos/${apiRepository}/compare/${
          encodeURIComponent(base)
        }...${encodeURIComponent(head)}`,
      compareWebUrl: (base, head) =>
        `${webRepository}/compare/${encodeURIComponent(base)}...${
          encodeURIComponent(head)
        }`,
    };
  }
  if (repository.hostname.toLowerCase() === "gitlab.com" && segments.length >= 2) {
    const project = segments.join("/");
    const encodedProject = encodeURIComponent(project);
    const webRepository = `https://gitlab.com/${project}`;
    return {
      provider: "gitlab",
      releasesUrl: `https://gitlab.com/api/v4/projects/${encodedProject}/releases?order_by=created_at&sort=desc&per_page=10`,
      compareUrl: (base, head) =>
        `https://gitlab.com/api/v4/projects/${encodedProject}/repository/compare?from=${
          encodeURIComponent(base)
        }&to=${encodeURIComponent(head)}`,
      compareWebUrl: (base, head) =>
        `${webRepository}/-/compare/${encodeURIComponent(base)}...${
          encodeURIComponent(head)
        }`,
    };
  }
  throw new Error("Release repositories must be public GitHub or GitLab URLs.");
}

function parseReleaseItem(value: unknown): InertiaReleaseInfo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const item = value as Record<string, unknown>;
  if (item.draft === true || item.prerelease === true) return null;
  const links = typeof item._links === "object" && item._links !== null
    && !Array.isArray(item._links)
    ? item._links as Record<string, unknown>
    : null;
  const tag = boundedString(item.tag ?? item.tag_name ?? item.tagName, 120);
  const createdAt = boundedString(
    item.createdAt ?? item.created_at ?? item.releasedAt ?? item.released_at
      ?? item.published_at,
    80,
  );
  if (!tag || !createdAt || Number.isNaN(Date.parse(createdAt))) return null;
  return {
    tag,
    name: boundedString(item.name, 180),
    url: boundedString(item.html_url ?? links?.self, 500),
    createdAt,
    releasedAt: boundedString(
      item.releasedAt ?? item.released_at ?? item.published_at,
      80,
    ),
    description: typeof (item.description ?? item.body) === "string"
      ? String(item.description ?? item.body).trim().slice(0, 8_000) || null : null,
  };
}

function discordWebhookUrl(value: unknown): string {
  const webhookUrl = boundedString(value, 500);
  if (!webhookUrl) throw new Error("A Discord webhook URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    throw new Error("The Discord webhook URL is invalid.");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:"
    || (host !== "discord.com" && host !== "discordapp.com")
    || parsed.username || parsed.password || parsed.port
    || !/^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/u.test(parsed.pathname)
  ) {
    throw new Error("The Discord webhook URL is invalid.");
  }
  parsed.hash = "";
  parsed.searchParams.set("wait", "true");
  return parsed.toString();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0]?.trim() ?? "";
}

function compactText(value: string, maximum: number): string {
  const trimmed = value.replace(/\s+/gu, " ").trim();
  return trimmed.length > maximum ? `${trimmed.slice(0, maximum - 1)}…` : trimmed;
}

function compactMarkdown(value: string, maximum: number): string {
  const trimmed = value
    .split(/\r?\n/u)
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return trimmed.length > maximum ? `${trimmed.slice(0, maximum - 1)}…` : trimmed;
}

function uniqueLimited(values: string[], maximum = 5): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const compact = compactText(value, 150);
    if (!compact || seen.has(compact.toLowerCase())) continue;
    seen.add(compact.toLowerCase());
    result.push(compact);
    if (result.length >= maximum) break;
  }
  return result;
}

function releaseMessage(
  release: InertiaReleaseInfo,
  previousRelease: InertiaReleaseInfo,
  compare: ReleaseCompare,
): Record<string, unknown> {
  const subjects = uniqueLimited(compare.commits.map(firstLine));
  const title = release.name || release.tag;
  return {
    content: `**${title}**`,
    embeds: [{
      title: `Comparativa ${previousRelease.tag} -> ${release.tag}`,
      url: compare.url,
      description: compactMarkdown(
        release.description || "Aquesta release no inclou notes publicades. Consulta la comparativa completa.",
        DISCORD_DESCRIPTION_LIMIT,
      ),
      color: 0x5865f2,
      fields: [
        ...(subjects.length ? [{ name: "Commits · vista prèvia", value: compactMarkdown(
          subjects.map((subject) => `- ${subject}`).join("\n"), DISCORD_FIELD_LIMIT,
        ), inline: false }] : []),
        ...(compare.limited ? [{ name: "Comparativa limitada", value:
          "La resposta supera el límit de previsualització. Es mostren les notes publicades, no una anàlisi completa del diff.",
        inline: false }] : []),
      ],
      footer: { text: "Notes de release i vista prèvia de commits. Obre el títol per veure tots els canvis." },
    }],
    allowed_mentions: { parse: [] },
  };
}

function validatedRelease(value: unknown): InertiaReleaseInfo {
  const release = parseReleaseItem(value);
  if (!release) throw new Error("The selected release is invalid.");
  return release;
}

function compareCommitMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((commit) => {
    if (typeof commit !== "object" || commit === null || Array.isArray(commit)) {
      return [];
    }
    const record = commit as Record<string, unknown>;
    const nested = typeof record.commit === "object" && record.commit !== null
      && !Array.isArray(record.commit)
      ? record.commit as Record<string, unknown>
      : null;
    const message = boundedString(record.message ?? nested?.message ?? record.title, 500);
    return message ? [message] : [];
  });
}

async function releaseCompare(
  fetch: typeof globalThis.fetch,
  repository: RepositoryDescriptor,
  previousRelease: InertiaReleaseInfo,
  release: InertiaReleaseInfo,
  signal: AbortSignal,
): Promise<ReleaseCompare> {
  const response = await fetch(
    repository.compareUrl(previousRelease.tag, release.tag),
    {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: repository.provider === "github"
          ? "application/vnd.github+json, application/json"
          : "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Inertia",
      },
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReleaseOperationError("discord.release-fetch-failed", "The release diff could not be loaded.", response.status);
  }
  const json = await boundedJson(response);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("The release diff response was invalid.");
  }
  const record = json as Record<string, unknown>;
  return {
    url: repository.compareWebUrl(previousRelease.tag, release.tag),
    commits: compareCommitMessages(record.commits),
    limited: false,
  };
}

export async function listInertiaReleases(
  fetch: typeof globalThis.fetch,
  request: SendDiscordReleaseInfoRequest,
): Promise<InertiaReleaseInfo[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(
      repositoryDescriptor(request?.repositoryUrl).releasesUrl,
      {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json, application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Inertia",
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReleaseOperationError("discord.release-fetch-failed", "The release list could not be loaded.", response.status);
    }
    const json = await boundedJson(response);
    if (!Array.isArray(json)) {
      throw new Error("The release response was invalid.");
    }
    return json
      .map(parseReleaseItem)
      .filter((release): release is InertiaReleaseInfo => release !== null)
      .sort((left, right) =>
        Date.parse(right.releasedAt ?? right.createdAt) - Date.parse(left.releasedAt ?? left.createdAt));
  } finally {
    clearTimeout(timer);
  }
}

export async function sendDiscordReleaseInfo(
  fetch: typeof globalThis.fetch,
  webhook: string,
  request: SendDiscordReleaseInfoRequest & {
    previousRelease: InertiaReleaseInfo;
    release: InertiaReleaseInfo;
  },
): Promise<{ sent: true; comparisonLimited: boolean }> {
  let webhookUrl: string;
  try { webhookUrl = discordWebhookUrl(webhook); }
  catch { throw new ReleaseOperationError("discord.webhook-missing", "A valid Discord webhook URL is required."); }
  const repository = repositoryDescriptor(request?.repositoryUrl);
  const previousRelease = validatedRelease(request?.previousRelease);
  const release = validatedRelease(request?.release);
  const preparation = new AbortController();
  const preparationTimer = setTimeout(() => preparation.abort(), RELEASE_FETCH_TIMEOUT_MS);
  let compare: ReleaseCompare;
  try {
    compare = await releaseCompare(fetch, repository, previousRelease, release, preparation.signal);
  } catch (error) {
    if (error instanceof ReleaseResponseTooLarge) {
      compare = { url: repository.compareWebUrl(previousRelease.tag, release.tag), commits: [], limited: true };
    } else {
      throw error instanceof ReleaseOperationError ? error : new ReleaseOperationError(
        "discord.release-fetch-failed", "Release information could not be prepared. Nothing was sent.",
      );
    }
  } finally { clearTimeout(preparationTimer); }
  // Preparation cannot consume the delivery deadline. Once POST begins, a
  // transport failure is ambiguous: never silently retry or claim non-delivery.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Inertia",
      },
      body: JSON.stringify(releaseMessage(release, previousRelease, compare)),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      const ambiguous = response.status >= 500 || response.status === 408;
      throw new ReleaseOperationError(ambiguous ? "discord.delivery-unknown" : "discord.delivery-rejected",
        ambiguous ? "Discord delivery could not be confirmed. Check the channel before sending again." : "Discord rejected the release message.", response.status);
    }
    const confirmation = await boundedJson(response);
    if (!confirmation || typeof confirmation !== "object" || Array.isArray(confirmation)
      || !("id" in confirmation) || typeof confirmation.id !== "string"
      || !/^[0-9]{1,20}$/u.test(confirmation.id)) {
      throw new ReleaseOperationError("discord.delivery-unknown", "Discord delivery could not be confirmed. Check the channel before sending again.");
    }
    return { sent: true, comparisonLimited: compare.limited };
  } catch (error) {
    throw error instanceof ReleaseOperationError ? error : new ReleaseOperationError(
      "discord.delivery-unknown", "Discord delivery could not be confirmed. Check the channel before sending again.",
    );
  } finally {
    clearTimeout(timer);
  }
}
