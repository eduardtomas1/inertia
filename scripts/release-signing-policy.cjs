const publicReleaseSigningSets = {
  "macos-arm64": {
    label: "macOS",
    names: [
      "MACOS_CSC_LINK",
      "MACOS_CSC_KEY_PASSWORD",
      "MACOS_APPLE_API_KEY_BASE64",
      "MACOS_APPLE_API_KEY_ID",
      "MACOS_APPLE_API_ISSUER",
    ],
  },
  "windows-x64": {
    label: "Windows",
    names: [
      "WINDOWS_CSC_LINK",
      "WINDOWS_CSC_KEY_PASSWORD",
    ],
  },
};

function hasCredential(environment, name) {
  return typeof environment[name] === "string" && environment[name].trim().length > 0;
}

function requireCompleteCredentialSet(label, names, environment = process.env) {
  const missing = names.filter((name) => !hasCredential(environment, name));
  if (missing.length > 0) {
    throw new Error(`${label} signing configuration is required and incomplete. Missing: ${missing.join(", ")}.`);
  }
  return true;
}

function requirePublicReleaseSigningSet(platform, environment = process.env) {
  const policy = publicReleaseSigningSets[platform];
  if (!policy) throw new Error("Public release signing validation requires macos-arm64 or windows-x64.");
  return requireCompleteCredentialSet(policy.label, policy.names, environment);
}

module.exports = {
  publicReleaseSigningSets,
  requireCompleteCredentialSet,
  requirePublicReleaseSigningSet,
};
