import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { readSubscriptionFile } from "./subscription-io";

export interface SubscriptionCredential {
  token: string;
  scope: string;
  kind: "key" | "session";
  keychain?: true;
}
export interface CredentialSource {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  read: typeof readSubscriptionFile;
  keychain: () => Promise<string | null>;
  interactive: boolean;
}
export const CURSOR_ENDPOINT = "https://api2.cursor.sh";
export const KIMI_ENDPOINT = "https://api.kimi.com/coding/v1";
const tokenSchema = z.string().min(1).max(64 * 1024);
const claimsSchema = z.object({ sub: z.string().min(1).max(512), iss: z.string().max(512).optional() });
const kimiConfigSchema = z.object({
  default_model: z.string().optional(),
  models: z.record(z.string(), z.object({ model: z.string(), provider: z.string() })),
  providers: z.record(z.string(), z.object({
    type: z.string(),
    base_url: z.string(),
    api_key: z.string().optional(),
    oauth: z.object({ storage: z.enum(["file", "keyring"]).default("file"), key: z.string() }).optional(),
  })),
});
const trimEnd = (value: string) => value.replace(/\/+$/u, "");

export function credentialContinuity(credential: SubscriptionCredential): string | null {
  if (credential.kind === "key") return `key\0${credential.token}`;
  const parts = credential.token.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = claimsSchema.safeParse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
    return claims.success ? `account\0${claims.data.iss ?? ""}\0${claims.data.sub}` : null;
  } catch {
    return null;
  }
}

export async function cursorCredential(source: CredentialSource): Promise<SubscriptionCredential | "deferred" | null> {
  const { env, platform } = source;
  if (trimEnd(env.CURSOR_API_ENDPOINT?.trim() || CURSOR_ENDPOINT) !== CURSOR_ENDPOINT) return null;
  const session = (token: string, keychain = false): SubscriptionCredential => ({
    token: tokenSchema.parse(token), scope: "cursor:subscription", kind: "session", ...(keychain ? { keychain: true as const } : {}),
  });
  if (env.CURSOR_AUTH_TOKEN?.trim()) return session(env.CURSOR_AUTH_TOKEN.trim());
  if (env.CURSOR_API_KEY?.trim() || env.AGENT_CLI_CREDENTIAL_STORE === "memory") return null;
  if (platform === "darwin" && env.AGENT_CLI_CREDENTIAL_STORE !== "file") {
    if (!source.interactive) return "deferred";
    const value = await source.keychain();
    return value ? session(value, true) : null;
  }
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const directory = platform === "win32"
    ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor")
    : platform === "darwin" ? join(home, ".cursor") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "cursor");
  const contents = await source.read(join(directory, "auth.json"));
  const value = contents ? z.object({ accessToken: tokenSchema.optional() }).parse(JSON.parse(contents)).accessToken : undefined;
  return value ? session(value) : null;
}

export async function kimiCredential(source: CredentialSource, model: string | undefined): Promise<SubscriptionCredential | null> {
  const { env, platform, read } = source;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const share = env.KIMI_SHARE_DIR || join(home, ".kimi");
  const toml = await read(join(share, "config.toml"));
  const legacy = toml === null ? await read(join(share, "config.json")) : null;
  if (toml === null && legacy === null) return null;
  const config = kimiConfigSchema.parse(toml !== null ? parseToml(toml) : JSON.parse(legacy!));
  const selected = !model || model === "provider-default" ? config.default_model : model.replace(/,thinking$/u, "");
  const exact = selected ? config.models[selected] : undefined;
  const matches = exact ? [exact] : Object.values(config.models).filter((entry) => entry.model === selected);
  if (matches.length !== 1) return null;
  const entry = matches[0]!;
  const providerConfig = config.providers[entry.provider];
  if (entry.provider !== "managed:kimi-code" || providerConfig?.type !== "kimi") return null;
  if (trimEnd(env.KIMI_BASE_URL || providerConfig.base_url) !== KIMI_ENDPOINT) return null;
  if (env.KIMI_CODE_BASE_URL && trimEnd(env.KIMI_CODE_BASE_URL) !== KIMI_ENDPOINT) return null;
  if (providerConfig.oauth) {
    if (providerConfig.oauth.storage !== "file" || providerConfig.oauth.key !== "oauth/kimi-code") return null;
    const credentials = await read(join(share, "credentials", "kimi-code.json"));
    if (credentials) {
      const account = z.object({ access_token: tokenSchema, expires_at: z.number().finite() }).parse(JSON.parse(credentials));
      if (account.expires_at * 1000 <= Date.now()) return null;
      return { token: account.access_token, scope: "kimi:code", kind: "session" };
    }
  }
  const key = env.KIMI_API_KEY?.trim() || providerConfig.api_key;
  return key ? { token: tokenSchema.parse(key), scope: "kimi:code", kind: "key" } : null;
}
