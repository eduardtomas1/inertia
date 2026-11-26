const packageJson = require("../package.json");
const path = require("node:path");

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
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TRUSTED_SIGNING_ENDPOINT",
  "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
  "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
  "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
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
    throw new Error(`${label} configuration is incomplete. Missing: ${missing.join(", ")}.`);
  }
  return present.length === names.length;
}

const macSigning = isMac && credentialSet(
  "macOS signing",
  [
    "CSC_LINK",
    "CSC_KEY_PASSWORD",
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ],
);
const windowsCertificateSigning = isWindows && credentialSet(
  "Windows signing",
  ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"],
);
const windowsAzureSigning = isWindows && credentialSet(
  "Windows Azure Trusted Signing",
  [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_TRUSTED_SIGNING_ENDPOINT",
    "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
    "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
    "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
  ],
);
if (windowsCertificateSigning && windowsAzureSigning) {
  throw new Error(
    "Windows signing configuration is ambiguous. Configure either WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD or Azure Trusted Signing, not both.",
  );
}

function azureSigningValue(name, valid) {
  const value = process.env[name];
  if (!valid(value)) {
    throw new Error(`Windows Azure Trusted Signing configuration has an invalid ${name}.`);
  }
  return value;
}

function validAzureEndpoint(value) {
  try {
    const url = new URL(value);
    return value === value.trim()
      && url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      && url.pathname === "/";
  } catch {
    return false;
  }
}

function validAzureResourceName(value) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u.test(value);
}

function validPublisherName(value) {
  return value === value.trim()
    && Buffer.byteLength(value, "utf8") >= 1
    && Buffer.byteLength(value, "utf8") <= 512
    && !value.includes("=")
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

const azureSignOptions = windowsAzureSigning
  ? {
      publisherName: azureSigningValue("AZURE_TRUSTED_SIGNING_PUBLISHER_NAME", validPublisherName),
      endpoint: azureSigningValue("AZURE_TRUSTED_SIGNING_ENDPOINT", validAzureEndpoint),
      codeSigningAccountName: azureSigningValue(
        "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
        validAzureResourceName,
      ),
      certificateProfileName: azureSigningValue(
        "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
        validAzureResourceName,
      ),
    }
  : null;
const windowsSigning = windowsCertificateSigning || windowsAzureSigning;
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

async function verifyWindowsNsisPayload(event) {
  if (!isWindows || event.target?.name !== "nsis" || path.extname(event.file).toLowerCase() !== ".exe") {
    return;
  }
  const architecture = platform === "windows-arm64" ? "arm64" : "x64";
  const [
    { verifyBuiltNsisApplicationArchive },
    { verifyWindowsInstallerCandidateMarker },
  ] = await Promise.all([
    import("./windows-installer-smoke.mjs"),
    import("./windows-update-lineage-build.mjs"),
  ]);
  await Promise.all([
    verifyBuiltNsisApplicationArchive({
      architecture,
      outputDirectory: path.dirname(event.file),
      sanitizedName: event.packager.appInfo.sanitizedName,
      version: event.packager.appInfo.version,
    }),
    verifyWindowsInstallerCandidateMarker(
      event.file,
      event.packager.platformSpecificBuildOptions.legalTrademarks,
    ),
  ]);
}

async function bindWindowsCandidateLineage(context) {
  const { bindWindowsInstallerToCandidateExecutable } = await import(
    "./windows-update-lineage-build.mjs"
  );
  await bindWindowsInstallerToCandidateExecutable(context);
}

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
  // The hook observes the final resource-edited/signed application executable;
  // NSIS is built and signed only after the digest is placed in its version
  // resource by the hook.
  ...(isWindows ? { afterSign: bindWindowsCandidateLineage } : {}),
  // electron-builder deletes the generated application archive after the
  // artifact hook returns. Inspect it here with the bundled 7z-capable tool;
  // the much smaller Windows 7za cannot parse an outer NSIS executable.
  artifactBuildCompleted: verifyWindowsNsisPayload,
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
    verifyUpdateCodeSignature: true,
    ...(azureSignOptions ? { azureSignOptions } : {}),
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
              StartupWMClass: desktopName.replace(/\.desktop$/, ""),
            },
          },
        }
      : {}),
  },
};
