const packageJson = require("../package.json");

const releaseChannel = process.env.INERTIA_RELEASE_CHANNEL ?? "stable";
if (releaseChannel !== "stable" && releaseChannel !== "canary") {
  throw new Error("INERTIA_RELEASE_CHANNEL must be stable or canary.");
}
const canary = releaseChannel === "canary";
const productName = canary ? "Inertia Canary" : "Inertia";
const appId = canary ? "dev.inertia.app.canary" : "dev.inertia.app";
const desktopName = canary
  ? "dev.inertia.app.desktop.canary"
  : packageJson.desktopName;
const updateFeedUrl = canary
  ? "https://raw.githubusercontent.com/eduardtomas1/inertia/canary-feed"
  : "https://github.com/eduardtomas1/inertia/releases/latest/download";

const platform = process.env.INERTIA_RELEASE_PLATFORM ?? "";
const supportedPlatforms = new Set([
  "macos-x64",
  "macos-arm64",
  "windows-x64",
  "windows-arm64",
  "linux-x64",
  "linux-arm64",
]);
if (!supportedPlatforms.has(platform)) {
  throw new Error("INERTIA_RELEASE_PLATFORM must identify the exact release platform.");
}
const isMac = platform.startsWith("macos-");
const isWindows = platform.startsWith("windows-");
const isLinux = platform.startsWith("linux-");

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

const macSigning = isMac && credentialSet(
  "macOS",
  [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ],
);
const windowsSigning = isWindows && credentialSet(
  "Windows",
  ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
);
const signingRequired = macSigning || windowsSigning;
const updateCapability = isLinux
  ? { delivery: "in-app", platform: "linux" }
  : isMac && macSigning
    ? { delivery: "in-app", platform: "darwin" }
    : isWindows && windowsSigning
      ? { delivery: "in-app", platform: "win32" }
      : {
          delivery: "manual",
          reason: isMac
            ? "macos-signing-unavailable"
            : "windows-signing-unavailable",
        };

module.exports = {
  ...packageJson.build,
  appId,
  productName,
  forceCodeSigning: signingRequired,
  // electron-builder still writes the update metadata and packaged
  // app-update.yml with --publish never. GitHub Actions remains the sole
  // publisher and uploads the validated union only after all builds pass.
  publish: [
    {
      provider: "generic",
      url: updateFeedUrl,
      ...(canary ? { channel: "canary" } : {}),
    },
  ],
  extraMetadata: {
    ...packageJson.build.extraMetadata,
    ...(canary ? { name: "inertia-canary" } : {}),
    desktopName,
    inertiaReleaseChannel: releaseChannel,
    inertiaUpdateCapability: updateCapability,
  },
  mac: {
    ...packageJson.build.mac,
    ...(canary
      ? { artifactName: "Inertia-Canary-${version}-${arch}.${ext}" }
      : {}),
    // Pull requests and community builds retain the explicit, testable ad-hoc
    // path. A complete release secret set switches to Developer ID discovery,
    // hardened runtime, fail-closed signing, and notarization.
    identity: macSigning ? undefined : "-",
    hardenedRuntime: true,
    notarize: macSigning,
  },
  win: {
    ...packageJson.build.win,
    // Keep the established x64 filename while giving the ARM64 installer and
    // its blockmap an architecture-qualified public identity.
    artifactName: canary
      ? platform === "windows-arm64"
        ? "Inertia.Canary.Setup.${version}.arm64.${ext}"
        : "Inertia.Canary.Setup.${version}.${ext}"
      : platform === "windows-arm64"
        ? "Inertia.Setup.${version}.arm64.${ext}"
        : packageJson.build.win.artifactName,
  },
  linux: {
    ...packageJson.build.linux,
    ...(canary
      ? {
          artifactName: platform === "linux-arm64"
            ? "Inertia-Canary-${version}-arm64.${ext}"
            : "Inertia-Canary-${version}.${ext}",
          executableName: "inertia-canary",
          desktop: {
            entry: {
              Name: productName,
              Comment: packageJson.description,
              StartupWMClass: productName,
            },
          },
        }
      : {}),
  },
};
