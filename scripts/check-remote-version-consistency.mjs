import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function assertRemoteReadmeVersions(readme, versions) {
  for (const [component, version] of [
    ["browser", versions.browser],
    ["relay", versions.relay],
  ]) {
    if (!readme.includes(`inertia-remote-${component}-${version}.tar.gz`)) {
      throw new Error(
        `The Remote Companion README uses an inconsistent ${component} artifact version.`,
      );
    }
  }
  if (!readme.includes(`/opt/inertia-remote-relay-${versions.relay}`)) {
    throw new Error(
      "The Remote Companion README uses an inconsistent relay installation path.",
    );
  }
}

export async function checkRemoteVersionConsistency(options = {}) {
  const versions = await readJson("remote/component-versions.json");
  for (const component of ["browser", "desktop", "relay"]) {
    if (!STABLE_VERSION.test(versions[component] ?? "")) {
      throw new Error(
        `The canonical Remote Companion ${component} version is invalid.`,
      );
    }
  }

  const browserPackage = await readJson("remote/browser/package.json");
  const relayPackage = await readJson("remote/relay/package.json");
  if (browserPackage.version !== versions.browser) {
    throw new Error(
      "The Remote Companion browser package version is inconsistent.",
    );
  }
  if (relayPackage.version !== versions.relay) {
    throw new Error(
      "The Remote Companion relay package version is inconsistent.",
    );
  }
  const relayServer = await readFile("remote/relay/server.mjs", "utf8");
  if (
    !relayServer.includes("const RELAY_VERSION = relayPackage.version;")
    || /const RELAY_VERSION = ["']\d+\.\d+\.\d+/u.test(relayServer)
  ) {
    throw new Error(
      "The Remote Companion relay runtime must read its package version.",
    );
  }

  const browserHtml = await readFile("remote/browser/index.html", "utf8");
  if (
    !browserHtml.includes(
      "version=__REMOTE_BROWSER_VERSION__;relay=2;remote=2",
    )
    || /version=\d+\.\d+\.\d+;relay=/u.test(browserHtml)
  ) {
    throw new Error(
      "The Remote Companion browser metadata must use the canonical build placeholder.",
    );
  }

  if (options.builtHtmlPath) {
    const builtHtml = await readFile(options.builtHtmlPath, "utf8");
    if (
      !builtHtml.includes(
        `version=${versions.browser};relay=2;remote=2`,
      )
      || builtHtml.includes("__REMOTE_BROWSER_VERSION__")
    ) {
      throw new Error(
        "The built Remote Companion browser metadata uses an inconsistent version.",
      );
    }
  }

  const caddy = await readFile(
    "remote/relay/Caddyfile.tailscale.example",
    "utf8",
  );
  if (!caddy.includes(`/srv/inertia-remote-browser-${versions.browser}/site`)) {
    throw new Error(
      "The Remote Companion Caddy example uses an inconsistent browser version.",
    );
  }

  const readme = await readFile("remote/README.md", "utf8");
  assertRemoteReadmeVersions(readme, versions);
  return versions;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await checkRemoteVersionConsistency({
    builtHtmlPath: "remote/browser/dist/index.html",
  });
}
