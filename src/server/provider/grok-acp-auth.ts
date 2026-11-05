import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHED_TOKEN_METHOD = "cached_token";
const API_KEY_METHOD = "xai.api_key";
const MAX_AUTH_FILE_BYTES = 1024 * 1024;

export interface GrokAcpAuthMethod {
  id: string;
}

export function selectGrokAcpAuthMethod(
  methods: readonly { id?: unknown }[] | null | undefined,
  environment: NodeJS.ProcessEnv,
): GrokAcpAuthMethod | null {
  const ids = new Set<string>();
  for (const method of methods ?? []) {
    if (typeof method?.id === "string" && method.id.length > 0) ids.add(method.id);
  }
  if (ids.has(CACHED_TOKEN_METHOD)) return { id: CACHED_TOKEN_METHOD };
  if (ids.has(API_KEY_METHOD) && grokApiKey(environment)) return { id: API_KEY_METHOD };
  return null;
}

export function grokCredentialPresence(
  environment: NodeJS.ProcessEnv,
): "present" | "absent" {
  if (grokApiKey(environment)) return "present";
  const root = environment.GROK_HOME?.trim() || join(homedir(), ".grok");
  try {
    const stat = statSync(join(root, "auth.json"));
    if (stat.isFile() && stat.size > 0 && stat.size <= MAX_AUTH_FILE_BYTES) return "present";
  } catch {
    return "absent";
  }
  return "absent";
}

function grokApiKey(environment: NodeJS.ProcessEnv): string {
  return environment.XAI_API_KEY?.trim()
    || environment.GROK_CODE_XAI_API_KEY?.trim()
    || "";
}
