const packageJson = require("../package.json");

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

function credentialSet(label, names) {
  const present = names.filter((name) => typeof process.env[name] === "string"
    && process.env[name].trim().length > 0);
  if (present.length > 0 && present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new Error(`${label} signing configuration is incomplete. Missing: ${missing.join(", ")}.`);
  }
  return present.length === names.length;
}

const macSigning = platform === "macos-arm64" && credentialSet(
  "macOS",
  [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ],
);
const windowsSigning = platform === "windows-x64" && credentialSet(
  "Windows",
  ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
);
const signingRequired = macSigning || windowsSigning;
const updateCapability = platform === "linux-x64"
  ? { delivery: "in-app", platform: "linux" }
  : platform === "macos-arm64" && macSigning
    ? { delivery: "in-app", platform: "darwin" }
    : platform === "windows-x64" && windowsSigning
      ? { delivery: "in-app", platform: "win32" }
      : {
          delivery: "manual",
          reason: platform === "macos-arm64"
            ? "macos-signing-unavailable"
            : "windows-signing-unavailable",
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
    // Pull requests and community builds retain the explicit, testable ad-hoc
    // path. A complete release secret set switches to Developer ID discovery,
    // hardened runtime, fail-closed signing, and notarization.
    identity: macSigning ? undefined : "-",
    hardenedRuntime: true,
    notarize: macSigning,
  },
};
