import type {
  InertiaReleaseInfo,
  ListInertiaReleasesRequest,
  SendDiscordReleaseInfoRequest,
} from "../shared/desktop.js";

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

interface ReleaseCompareChange {
  path: string;
  status: string;
  patch: string | null;
}

interface ReleaseCompare {
  url: string | null;
  commits: string[];
  files: ReleaseCompareChange[];
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
    throw new Error("The release response was too large.");
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
        throw new Error("The release response was too large.");
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
  if (parsed.protocol !== "https:") {
    throw new Error("The release repository URL must use HTTPS.");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\.git$/u, "").replace(/\/+$/u, "");
  return parsed;
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
    description: boundedString(item.description ?? item.body, 8_000),
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
    || !parsed.pathname.startsWith("/api/webhooks/")
  ) {
    throw new Error("The Discord webhook URL is invalid.");
  }
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

function cleanedCommitSummary(value: string): string {
  return compactText(
    firstLine(value)
      .replace(/^\s*(feat|fix|chore|refactor|perf|test|docs|style|build|ci)(\([^)]+\))?:\s*/iu, "")
      .replace(/\s+\(#[0-9]+\)\s*$/u, ""),
    150,
  );
}

function classifyChange(text: string): "Millores" | "Implementacions" | "Bugs" | "Altres" {
  if (/\b(fix|bug|crash|error|fail|failure|regression|broken|invalid|null|undefined|exception|repair|recover)\b/iu.test(text)) {
    return "Bugs";
  }
  if (/^\s*(add|create|implement|support|persist|integrat|feature|endpoint|api|webhook|migration|schema)\b/iu.test(text)) {
    return "Implementacions";
  }
  if (/\b(improve|polish|refactor|cleanup|simplif|optim|performance|ux|ui|rename|update|better|enhance)\b/iu.test(text)) {
    return "Millores";
  }
  if (/\b(add|create|implement|support|persist|integrat|feature|endpoint|api|webhook|migration|schema|release|config|setting)\b/iu.test(text)) {
    return "Implementacions";
  }
  return "Altres";
}

function fileChangeSummary(file: ReleaseCompareChange): string {
  if (/settingsview|styles\.css/iu.test(file.path)) {
    return "Millorada la configuració de Discord i el flux de generació.";
  }
  if (/inertia-releases/iu.test(file.path)) {
    return "Afegida generació d'un resum de release a partir del compare entre tags.";
  }
  if (/persistence|migration|settings-repository|codecs|rows/iu.test(file.path)) {
    return "Persistida la configuració de Discord perquè l'app arrenqui amb valors buits si no està configurada.";
  }
  if (/contracts|preload|main\/index|desktop/iu.test(file.path)) {
    return "Connectada la configuració de Discord entre la UI i el procés principal.";
  }
  if (/test|spec/iu.test(file.path)) {
    return "Afegida cobertura automàtica del flux de releases i de les migracions.";
  }
  if (/check-renderer-bundle/iu.test(file.path)) {
    return "Ajustat el pressupost del bundle després d'afegir la nova funcionalitat.";
  }
  const basename = file.path.split(/[\\/]/u).at(-1) ?? file.path;
  return file.status === "removed"
    ? `Eliminada una peça interna relacionada amb ${basename}.`
    : `Actualitzada una peça interna relacionada amb ${basename}.`;
}

function releaseAnalysis(compare: ReleaseCompare): Record<"Millores" | "Implementacions" | "Bugs" | "Altres", string[]> {
  const grouped: Record<"Millores" | "Implementacions" | "Bugs" | "Altres", string[]> = {
    Millores: [],
    Implementacions: [],
    Bugs: [],
    Altres: [],
  };
  for (const commit of compare.commits) {
    const line = cleanedCommitSummary(commit);
    grouped[classifyChange(line)].push(line);
  }
  for (const file of compare.files) {
    const evidence = `${file.status} ${file.path} ${file.patch ?? ""}`;
    grouped[classifyChange(evidence)].push(fileChangeSummary(file));
  }
  return {
    Millores: uniqueLimited(grouped.Millores),
    Implementacions: uniqueLimited(grouped.Implementacions),
    Bugs: uniqueLimited(grouped.Bugs),
    Altres: uniqueLimited(grouped.Altres),
  };
}

function sectionText(items: string[]): string {
  const bullets = items.length > 0 ? items : ["Sense canvis detectats en aquesta categoria."];
  return compactMarkdown(bullets.map((item) => `- ${item}`).join("\n"), DISCORD_FIELD_LIMIT);
}

function releaseMessage(
  release: InertiaReleaseInfo,
  previousRelease: InertiaReleaseInfo,
  compare: ReleaseCompare,
): Record<string, unknown> {
  const analysis = releaseAnalysis(compare);
  const title = release.name || release.tag;
  return {
    content: `**${title}**`,
    embeds: [{
      title: `Comparativa ${previousRelease.tag} -> ${release.tag}`,
      url: compare.url ?? release.url ?? undefined,
      description: compactMarkdown(
        "Resum explicat dels canvis detectats entre aquesta release i l'anterior.",
        DISCORD_DESCRIPTION_LIMIT,
      ),
      color: 0x5865f2,
      fields: [
        { name: "Millores", value: sectionText(analysis.Millores), inline: false },
        { name: "Implementacions", value: sectionText(analysis.Implementacions), inline: false },
        { name: "Bugs", value: sectionText(analysis.Bugs), inline: false },
        { name: "Altres", value: sectionText(analysis.Altres), inline: false },
      ],
      footer: compare.url ? { text: "Obre el títol per veure el diff complet." } : undefined,
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

function compareFiles(value: unknown): ReleaseCompareChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) {
      return [];
    }
    const record = file as Record<string, unknown>;
    const path = boundedString(
      record.filename ?? record.new_path ?? record.old_path,
      300,
    );
    if (!path) return [];
    return [{
      path,
      status: boundedString(record.status ?? record.change_type, 40) ?? "modified",
      patch: boundedString(record.patch ?? record.diff, 2_000),
    }];
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
  if (!response.ok) throw new Error("The release diff could not be loaded.");
  const json = await boundedJson(response);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new Error("The release diff response was invalid.");
  }
  const record = json as Record<string, unknown>;
  return {
    url: boundedString(record.html_url ?? record.web_url, 500)
      ?? repository.compareWebUrl(previousRelease.tag, release.tag),
    commits: compareCommitMessages(record.commits),
    files: compareFiles(record.files ?? record.diffs),
  };
}

export async function listInertiaReleases(
  fetch: typeof globalThis.fetch,
  request: ListInertiaReleasesRequest,
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
    if (!response.ok) throw new Error("The release list could not be loaded.");
    const json = await boundedJson(response);
    if (!Array.isArray(json)) {
      throw new Error("The release response was invalid.");
    }
    return json
      .map(parseReleaseItem)
      .filter((release): release is InertiaReleaseInfo => release !== null)
      .sort((left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt));
  } finally {
    clearTimeout(timer);
  }
}

export async function sendDiscordReleaseInfo(
  fetch: typeof globalThis.fetch,
  webhook: string,
  request: SendDiscordReleaseInfoRequest,
): Promise<{ sent: true }> {
  const webhookUrl = discordWebhookUrl(webhook);
  const repository = repositoryDescriptor(request?.repositoryUrl);
  const previousRelease = validatedRelease(request?.previousRelease);
  const release = validatedRelease(request?.release);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_WEBHOOK_TIMEOUT_MS);
  try {
    const compare = await releaseCompare(
      fetch,
      repository,
      previousRelease,
      release,
      controller.signal,
    );
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
      throw new Error("The release info could not be sent to Discord.");
    }
    return { sent: true };
  } finally {
    clearTimeout(timer);
  }
}
