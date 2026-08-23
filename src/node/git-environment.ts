/**
 * Ambient Git settings that are safe to preserve across supervised process
 * boundaries. Keep command-scoped repository overrides in the Git runner.
 */
export const GIT_LAUNCH_ENVIRONMENT_KEYS = [
  "EMAIL",
  "GCM_INTERACTIVE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GNUPGHOME",
  "GPG_TTY",
] as const;
