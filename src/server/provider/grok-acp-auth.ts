import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHED_TOKEN_METHOD = "cached_token";
const API_KEY_METHOD = "xai.api_key";
const MAX_AUTH_FILE_BYTES = 1024 * 1024;

export function selectGrokAcpAuthMethod(
  methods: readonly { id?: unknown }[] | null | undefined,
  environment: NodeJS.ProcessEnv,
): string {
  const ids = new Set((methods ?? []).map((method) => method?.id));
  return !ids.has(CACHED_TOKEN_METHOD) && grokApiKey(environment)
    ? API_KEY_METHOD
    : CACHED_TOKEN_METHOD;
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
