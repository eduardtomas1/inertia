/**
 * Reviewed provider routing and behavior controls that contain no credential
 * values. Authentication material is intentionally absent from this list.
 */
export const PROVIDER_ROUTING_ENVIRONMENT_KEYS = [
  "AICORE_DEPLOYMENT_ID",
  "AICORE_RESOURCE_GROUP",
  "AI_API_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
  "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "AWS_CA_BUNDLE",
  "AWS_CONFIG_FILE",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_RESOURCE_NAME",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "DISABLE_AUTOUPDATER",
  "DISABLE_BUG_COMMAND",
  "DISABLE_ERROR_REPORTING",
  "DISABLE_PROMPT_CACHING",
  "DISABLE_TELEMETRY",
  "GITLAB_AI_GATEWAY_URL",
  "GITLAB_INSTANCE_URL",
  "GITLAB_OAUTH_CLIENT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "OPENAI_API_VERSION",
  "OPENAI_BASE_URL",
  "OPENAI_ENDPOINT",
  "SNOWFLAKE_ACCOUNT",
  "VERTEX_LOCATION",
] as const;

export const PROVIDER_ENDPOINT_ROUTING_ENVIRONMENT_KEY =
  /^AWS_ENDPOINT_URL(?:_[A-Z0-9_]+)?$/u;

/**
 * Fixed-name provider routes whose values cross the outer Electron boundary.
 * These are validated as credential-free HTTP(S) endpoints before they reach
 * the supervised runtime; non-URL provider controls retain their own syntax.
 */
export const PROVIDER_HTTP_ENDPOINT_ROUTING_ENVIRONMENT_KEYS = [
  "AI_API_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_ENDPOINT",
  "GITLAB_AI_GATEWAY_URL",
  "GITLAB_INSTANCE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_ENDPOINT",
] as const;

export const CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEYS = [
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
] as const;

export type ClaudeCloudRoutingEnvironmentKey =
  typeof CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEYS[number];

const CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEY_SET = new Set<string>(
  CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEYS,
);

const CLAUDE_CLOUD_BOOLEAN_ENVIRONMENT_KEYS = new Set<string>([
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
]);

const CLAUDE_CLOUD_HTTP_ENDPOINT_ENVIRONMENT_KEYS = new Set<string>([
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
]);

const CLAUDE_BOOLEAN_VALUES = new Set([
  "0",
  "1",
  "false",
  "no",
  "off",
  "on",
  "true",
  "yes",
]);

const CLAUDE_TRUTHY_BOOLEAN_VALUES = new Set([
  "1",
  "on",
  "true",
  "yes",
]);

const CLAUDE_BEDROCK_REGION_PREFIXES = new Set([
  "apac",
  "au",
  "eu",
  "global",
  "jp",
  "us",
]);

const HTTP_ENDPOINT_PROTOCOLS = new Set(["http:", "https:"]);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const URL_DOT_SEGMENT = /(?:^|[\\/])\.{1,2}(?=[\\/?#]|$)/u;
const PROVIDER_ENDPOINT_PATH_COMPONENT = /^[A-Za-z0-9._~-]+$/u;
const SECRET_ENDPOINT_PATH_COMPONENT =
  /(?:^|[-_.])(?:api[-_.]?key|authorization|bearer|credential|password|passwd|pwd|secret|session[-_.]?token|token)(?:$|[-_.=:])/iu;
const SECRET_ENDPOINT_PATH_VALUE =
  /^(?:api|key|pk|rk|sk|token|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}$/iu;
const MAXIMUM_URL_DECODE_PASSES = 4;
const MAXIMUM_PROVIDER_ENDPOINT_LENGTH = 2_048;
const MAXIMUM_PROVIDER_ENDPOINT_PATH_LENGTH = 512;
const MAXIMUM_PROVIDER_ENDPOINT_PATH_COMPONENTS = 16;
const MAXIMUM_PROVIDER_ENDPOINT_PATH_COMPONENT_LENGTH = 128;
const MAXIMUM_CLAUDE_BOOLEAN_LENGTH = 16;
const MAXIMUM_CLAUDE_REGION_PREFIX_LENGTH = 16;
const MAXIMUM_CLAUDE_TEXT_LENGTH = 256;

function decodedUrlRepresentations(value: string): string[] | null {
  const representations = [value];
  let current = value;
  for (let pass = 0; pass < MAXIMUM_URL_DECODE_PASSES; pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) return representations;
    representations.push(decoded);
    current = decoded;
  }
  try {
    return decodeURIComponent(current) === current ? representations : null;
  } catch {
    return null;
  }
}

function safeProviderEndpointPath(pathname: string): boolean {
  const representations = decodedUrlRepresentations(pathname);
  if (representations === null) return false;
  const decoded = representations.at(-1)!;
  if (
    decoded.length > MAXIMUM_PROVIDER_ENDPOINT_PATH_LENGTH
    || CONTROL_CHARACTER.test(decoded)
    || /[\\@?#]/u.test(decoded)
  ) return false;
  const components = decoded.split("/").filter(Boolean);
  return components.length <= MAXIMUM_PROVIDER_ENDPOINT_PATH_COMPONENTS
    && components.every((component) =>
      component.length <= MAXIMUM_PROVIDER_ENDPOINT_PATH_COMPONENT_LENGTH
      && PROVIDER_ENDPOINT_PATH_COMPONENT.test(component)
      && !SECRET_ENDPOINT_PATH_COMPONENT.test(component)
      && !SECRET_ENDPOINT_PATH_VALUE.test(component));
}

export function isCredentialFreeProviderHttpEndpoint(value: string): boolean {
  if (value.length === 0 || value.length > MAXIMUM_PROVIDER_ENDPOINT_LENGTH) {
    return false;
  }
  const representations = decodedUrlRepresentations(value);
  if (
    representations === null
    || representations.some((candidate) =>
      CONTROL_CHARACTER.test(candidate) || URL_DOT_SEGMENT.test(candidate))
  ) return false;
  try {
    const parsed = new URL(value);
    return HTTP_ENDPOINT_PROTOCOLS.has(parsed.protocol)
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.search.length === 0
      && parsed.hash.length === 0
      && safeProviderEndpointPath(parsed.pathname);
  } catch {
    return false;
  }
}

export function isClaudeCloudRoutingEnvironmentKey(
  key: string,
): key is ClaudeCloudRoutingEnvironmentKey {
  return CLAUDE_CLOUD_ROUTING_ENVIRONMENT_KEY_SET.has(key);
}

export function isClaudeCloudRoutingEnvironmentEnabled(
  value: string | undefined,
): boolean {
  if (value === undefined || value.length > MAXIMUM_CLAUDE_BOOLEAN_LENGTH) {
    return false;
  }
  return CLAUDE_TRUTHY_BOOLEAN_VALUES.has(value.trim().toLowerCase());
}

export function isValidClaudeCloudRoutingEnvironmentValue(
  key: ClaudeCloudRoutingEnvironmentKey,
  value: string,
): boolean {
  if (CLAUDE_CLOUD_HTTP_ENDPOINT_ENVIRONMENT_KEYS.has(key)) {
    return isCredentialFreeProviderHttpEndpoint(value);
  }
  if (CLAUDE_CLOUD_BOOLEAN_ENVIRONMENT_KEYS.has(key)) {
    if (value.length > MAXIMUM_CLAUDE_BOOLEAN_LENGTH) return false;
    return CLAUDE_BOOLEAN_VALUES.has(value.trim().toLowerCase());
  }
  if (key === "ANTHROPIC_BEDROCK_REGION_PREFIX") {
    if (value.length > MAXIMUM_CLAUDE_REGION_PREFIX_LENGTH) return false;
    return CLAUDE_BEDROCK_REGION_PREFIXES.has(value.trim());
  }
  if (value.length > MAXIMUM_CLAUDE_TEXT_LENGTH) return false;
  return value.trim().length > 0 && !CONTROL_CHARACTER.test(value);
}
