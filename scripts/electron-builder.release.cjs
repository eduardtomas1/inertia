const packageJson = require("../package.json");
const { requireCompleteCredentialSet } = require("./release-signing-policy.cjs");

const platform = process.env.INERTIA_RELEASE_PLATFORM ?? "";
const supportedPlatforms = new Set(["macos-arm64", "windows-x64", "linux-x64"]);
if (!supportedPlatforms.has(platform)) {
  throw new Error("INERTIA_RELEASE_PLATFORM must identify the exact release platform.");
}

const credentialEnvironmentKeys = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
  "WIN_CSC_LINK",
  "WIN_CSC_KEY_PASSWORD",
];
for (const name of credentialEnvironmentKeys) {
  if (typeof process.env[name] === "string" && process.env[name].trim().length === 0) {
    delete process.env[name];
  }
}

const macSigning = platform === "macos-arm64" && requireCompleteCredentialSet(
  "macOS",
  [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ],
);
const windowsSigning = platform === "windows-x64" && requireCompleteCredentialSet(
  "Windows",
  ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
);
const signingRequired = macSigning || windowsSigning;
const updateCapability = {
  delivery: "in-app",
  platform: {
    "macos-arm64": "darwin",
    "windows-x64": "win32",
    "linux-x64": "linux",
  }[platform],
};

module.exports = {
  ...packageJson.build,
  forceCodeSigning: signingRequired,
  // electron-builder still writes the update metadata and packaged
  // app-update.yml with --publish never. GitHub Actions remains the sole
  // publisher and uploads the validated union only after all builds pass.
  publish: [
    {
      provider: "generic",
      url: "https://github.com/eduardtomas1/inertia/releases/latest/download",
    },
  ],
  extraMetadata: {
    ...packageJson.build.extraMetadata,
    inertiaUpdateCapability: updateCapability,
  },
  mac: {
    ...packageJson.build.mac,
    // This configuration is release-only. Contributor CI uses its own config
    // and identity; a public macOS build must use Developer ID and notarization.
    identity: undefined,
    hardenedRuntime: true,
    notarize: true,
  },
};
