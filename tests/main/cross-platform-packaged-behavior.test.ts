import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PLATFORMS } from "../../scripts/ci/evidence-plan.mjs";

const repositoryRoot = process.cwd();

async function source(path: string): Promise<string> {
  return (await readFile(join(repositoryRoot, path), "utf8")).replaceAll(/\r\n?/gu, "\n");
}

function workflowStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function workflowJob(workflow: string, id: string): string {
  const marker = `\n  ${id}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing CI job ${id}.`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/mu);
  return workflow.slice(start, next < 0 ? undefined : start + marker.length + next);
}

describe("cross-platform packaged behavior contract", () => {
  it("keeps Canary packages behind the full smoke, fuse, checksum, provenance, and atomic-feed gate", async () => {
    const workflow = await source(".github/workflows/release-platforms.yml");
    for (const expected of [
      '- "canary-v*.*.*"',
      "INERTIA_RELEASE_CHANNEL:",
      "npm run verify:fuses -- \"$app\"",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
      "node scripts/release-assets.mjs finalize",
      "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
      "node scripts/prepare-canary-feed.mjs",
      "--prerelease --latest=false",
      "HEAD:canary-feed",
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("keeps build, Electron E2E, fuse verification, and native smoke on all six CI targets", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    expect(PLATFORMS.map(({ runner }: { runner: string }) => runner)).toEqual([
      "ubuntu-24.04", "ubuntu-24.04-arm", "windows-2025", "windows-11-arm", "macos-15", "macos-15-intel",
    ]);
    for (const expected of [
      "run: npm run check:quality",
      "run: npm run build:packaged",
      "run: npm run test:native-architecture",
      "run: npm exec -- playwright test --project=display-sensitive",
      "run: npm exec -- playwright test --project=isolated",
      "run: npm exec -- playwright test --project=runtime-recovery",
      "run: xvfb-run --auto-servernum npm exec -- playwright test --project=display-sensitive",
      "run: xvfb-run --auto-servernum npm exec -- playwright test --project=isolated",
      "run: xvfb-run --auto-servernum npm exec -- playwright test --project=runtime-recovery",
      'run: npm run "${{ matrix.release_package_script }}"',
      'node scripts/release-assets.mjs stage "$RELEASE_PLATFORM"',
      "npm run verify:fuses -- \"$app\"",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("registers runtime socket handlers before sending the first hydration frame", async () => {
    const boundary = await source("src/server/runtime/websocket-boundary.ts");
    const start = boundary.indexOf('webSockets.on("connection"');
    const end = boundary.indexOf("\n  return {", start);
    const connectionHandler = boundary.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(connectionHandler.indexOf('socket.on("message"')).toBeLessThan(
      connectionHandler.indexOf("runtimeSync.connect("),
    );
  });

  it("keeps attachment cleanup behind runtime ownership and shutdown", async () => {
    const main = await source("src/main/index.ts");
    const updateStartup = await source("src/main/app-update-startup.ts");
    const closedStart = main.indexOf('window.on("closed"');
    const closedEnd = main.indexOf("\n  });", closedStart);
    const closedHandler = main.slice(closedStart, closedEnd);
    expect(closedStart).toBeGreaterThanOrEqual(0);
    expect(closedHandler).not.toContain("disposeImportedAttachments");

    const releaseCoordination = await source(
      "src/main/attachment-release-coordination.ts",
    );
    const releaseFunction = releaseCoordination.slice(
      releaseCoordination.indexOf("export async function releaseRendererAttachment"),
    );
    expect(releaseFunction.indexOf("deferAttachmentRelease")).toBeLessThan(
      releaseFunction.indexOf("releaseFromRenderer"),
    );

    const cleanupStart = main.indexOf("function runPrivilegedCleanup()");
    const cleanupEnd = main.indexOf("\nasync function bootstrap()", cleanupStart);
    const cleanupHandler = main.slice(cleanupStart, cleanupEnd);
    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(cleanupHandler).toContain("new RetryablePrivilegedCleanup({");
    expect(cleanupHandler).toContain(
      'runtime: supervisorToStop && { stop: () => testCleanupOwners.observe("runtime", () => supervisorToStop.stop()) }',
    );
    expect(cleanupHandler).toContain(
      'disposeTemporaryAttachments: () => testCleanupOwners.observe("temporaryAttachments", disposeImportedAttachments)',
    );
    expect(cleanupHandler).toContain(
      "Retaining temporary attachments because runtime process exit was not confirmed",
    );
    expect(cleanupHandler.indexOf("conversationAttachments = null"))
      .toBeGreaterThan(cleanupHandler.indexOf("closeConversationAttachmentAccess"));
    expect(cleanupHandler).toContain("if (confirmed) await disposeWindowsRuntimeJobExecutableLock();");
    expect(cleanupHandler).not.toContain("finally { await disposeWindowsRuntimeJobExecutableLock()");

    const quitStart = updateStartup.indexOf('application.on("before-quit"');
    const quitEnd = updateStartup.indexOf("\n  });", quitStart);
    const quitHandler = updateStartup.slice(quitStart, quitEnd);
    expect(quitHandler).toContain("coordinator?.allowBeforeQuit()");
    expect(quitHandler).toContain("options.cleanupBeforeQuit().then(");
    expect(quitHandler).toContain("finishNormalShutdownAfterCleanup({");
    expect(quitHandler).toContain("cleanupConfirmed,");
    expect(main.indexOf("conversationAttachments = null")).toBeGreaterThan(
      main.indexOf("closeConversationAttachmentAccess(retainedAttachments)"),
    );
    expect(main).not.toContain("finally(finishQuitAfterCleanup)");
    expect(main.indexOf('recordPackageSmokeStage("app-exit")')).toBeLessThan(
      main.indexOf("process.exit(0)"),
    );
    expect(main.indexOf("windowToClose.destroy()")).toBeLessThan(
      main.indexOf('recordPackageSmokeStage("app-exit")'),
    );
    expect(main).not.toContain("app.exit(0)");
    expect(main).toContain("attachmentReservation = orphanReservation");
    expect(main).toContain(
      "reservedRecords: attachmentReservation.records",
    );
    expect(main).toContain(
      "reservedBytes: attachmentReservation.bytes",
    );
  });

  it("hides native previews when the renderer reloads or exits and destroys them with the window", async () => {
    const main = await source("src/main/index.ts");
    expect(main).toContain('window.webContents.on("did-start-navigation"');
    expect(main).toContain(
      "if (details.isMainFrame && !details.isSameDocument) previewBroker.releaseSurfaces()",
    );
    expect(main).toMatch(
      /window\.webContents\.on\("render-process-gone", \(_event, details\) => \{\s*previewBroker\.releaseSurfaces\(\);/u,
    );
    expect(main).toMatch(/window\.on\("closed", \(\) => \{[^}]*previewBroker\.close\(\);/u);
  });

  it("keeps exact-tag release packages and smoke validation aligned across every platform", async () => {
    const workflow = await source(".github/workflows/release-platforms.yml");
    const releaseValidator = await source("scripts/validate-release.mjs");
    const releaseAssets = await source("scripts/release-assets.mjs");
    for (const expected of [
      'tags:',
      '- "v*.*.*"',
      "package_script: package:release:mac",
      "package_script: package:release:mac:x64",
      "package_script: package:release:win",
      "package_script: package:release:win:arm64",
      "package_script: package:release:linux",
      "package_script: package:release:linux:arm64",
      "name: release-macos-x64",
      "name: release-macos-arm64",
      "name: release-windows-x64",
      "name: release-windows-arm64",
      "name: release-linux-x64",
      "name: release-linux-arm64",
      "node scripts/validate-release.mjs",
      "run: npm run test:browser-evidence-cpu-budget",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
      "codesign --verify --deep --strict",
      "xcrun stapler validate",
      "Get-AuthenticodeSignature",
      "Install locked release-validation dependencies",
      "run: npm ci --ignore-scripts",
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).toContain("MACOS_APPLE_API_KEY_BASE64");
    expect(workflow).toContain("WINDOWS_CSC_LINK");
    expect(workflow).not.toContain("BEGIN PRIVATE KEY");

    const releaseIdentity = workflowJob(workflow, "release_identity");
    expect(releaseIdentity).toContain("release_sha: ${{ steps.freeze.outputs.release_sha }}");
    expect(releaseIdentity).toContain('release_sha="$(git rev-parse --verify "${release_ref}^{commit}")"');
    expect(releaseIdentity).toContain('[[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]');
    expect(releaseIdentity).toContain('printf \'release_sha=%s\\n\' "$release_sha" >> "$GITHUB_OUTPUT"');

    for (const [jobId, prerequisite] of [
      ["build", "needs: [release_identity, quality]"],
      ["upload", "needs: [release_identity, build]"],
      ["publish-canary-feed", "needs: [release_identity, upload]"],
    ] as const) {
      const job = workflowJob(workflow, jobId);
      expect(job).toContain(prerequisite);
      expect(job).toContain("ref: ${{ needs.release_identity.outputs.release_sha }}");
      expect(job).toContain("RELEASE_EXPECTED_COMMIT: ${{ needs.release_identity.outputs.release_sha }}");
      expect(job).toContain('event_sha="${PUSH_EVENT_SHA:-$RELEASE_EXPECTED_COMMIT}"');
    }
    expect(workflowJob(workflow, "build")).toContain(
      "RELEASE_SOURCE_SHA: ${{ needs.release_identity.outputs.release_sha }}",
    );
    expect(workflowJob(workflow, "upload")).toContain(
      "RELEASE_SOURCE_SHA: ${{ needs.release_identity.outputs.release_sha }}",
    );
    const canaryFeedJob = workflowJob(workflow, "publish-canary-feed");
    expect(canaryFeedJob).toContain('RELEASE_VERIFY_REMOTE: "1"');
    expect(canaryFeedJob).toContain(
      "RELEASE_SOURCE_SHA: ${{ needs.release_identity.outputs.release_sha }}",
    );
    expect(canaryFeedJob.match(/^\s+revalidate_frozen_tag\s*$/gmu)).toHaveLength(1);
    expect(canaryFeedJob.lastIndexOf("revalidate_frozen_tag")).toBeLessThan(
      canaryFeedJob.indexOf("git -C \"$feed_worktree\" push origin HEAD:canary-feed"),
    );
    expect(releaseValidator).toContain('const commitPattern = /^[0-9a-f]{40}$/u;');
    expect(releaseValidator).toContain(
      'if (headCommit !== expectedCommit) fail("checked-out HEAD does not equal the frozen release commit")',
    );
    expect(releaseValidator).toContain(
      'if (tagCommit !== expectedCommit) fail("the release tag no longer points to the frozen release commit")',
    );
    expect(releaseAssets).toContain('"--package-lock-only"');
    expect(releaseAssets).toContain('"inertia:release-asset-sha256"');
    expect(releaseAssets).toContain(
      'const sbomName = `Inertia-${version}.sbom.cdx.json`',
    );
    expect(releaseAssets).toContain("inertia:release-source-sha");
    expect(releaseAssets).toContain("inertia:package-lock-sha256");
    expect(releaseAssets).toContain("inertia:electron-version");
    expect(workflow.match(/node-version: 22\.23\.2/gu)).toHaveLength(2);
    expect(workflow).toContain(
      "group: release-${{ inputs.release_tag || github.ref_name }}",
    );
    expect(workflow).not.toContain(
      "group: release-${{ inputs.release_tag || github.ref }}",
    );

    for (const [label, runner, platform, architecture, packageScript] of [
      ["macOS x64", "macos-15-intel", "macos-x64", "x64", "package:release:mac:x64"],
      ["macOS arm64", "macos-15", "macos-arm64", "arm64", "package:release:mac"],
      ["Windows x64", "windows-2025", "windows-x64", "x64", "package:release:win"],
      ["Windows ARM64", "windows-11-arm", "windows-arm64", "arm64", "package:release:win:arm64"],
      ["Linux x64", "ubuntu-24.04", "linux-x64", "x64", "package:release:linux"],
      ["Linux ARM64", "ubuntu-24.04-arm", "linux-arm64", "arm64", "package:release:linux:arm64"],
    ] as const) {
      const targets = parse(workflow).jobs.build.strategy.matrix.include as Array<{ label: string }>;
      expect(targets.find((target) => target.label === label)).toMatchObject({
        runner, platform, arch: architecture, package_script: packageScript,
      });
    }

    const releaseBundle = workflowStep(
      workflow,
      "Build the release application bundle once",
    );
    expect(releaseBundle).toContain("run: npm run build:packaged");
    expect(workflow.match(/run: npm run build:packaged/gu)).toHaveLength(1);
    expect(workflow).not.toContain("dist:release:");
    expect(workflowStep(
      workflow,
      "Run release-candidate platform performance guard",
    )).toContain("run: npm run benchmark:platform:smoke");
    expect(workflowStep(
      workflow,
      "Measure release-candidate desktop workloads",
    )).toContain("run: npm run benchmark:desktop:built");
    expect(workflowStep(
      workflow,
      "Measure release-candidate desktop workloads under Xvfb",
    )).toContain("xvfb-run --auto-servernum npm run benchmark:desktop:built");
    expect(workflowStep(workflow, "Keep release benchmark evidence"))
      .toContain("name: release-performance-${{ matrix.platform }}");

    const macBuild = workflowStep(workflow, "Build macOS release package");
    expect(macBuild).toContain("if: runner.os == 'macOS'");
    expect(macBuild).toContain("PACKAGE_SCRIPT: ${{ matrix.package_script }}");
    expect(macBuild).toContain("MACOS_CSC_LINK");
    expect(macBuild).toContain('if [[ -z "${!name:-}" ]]');
    expect(macBuild).toContain('unset "$name"');
    expect(macBuild).not.toContain("WINDOWS_CSC_LINK");

    const windowsBuild = workflowStep(workflow, "Build Windows release package");
    expect(windowsBuild).toContain("if: runner.os == 'Windows'");
    expect(windowsBuild).toContain("PACKAGE_SCRIPT: ${{ matrix.package_script }}");
    expect(windowsBuild).toContain("WINDOWS_CSC_LINK");
    expect(windowsBuild).toContain('if [[ -z "${!name:-}" ]]');
    expect(windowsBuild).toContain('unset "$name"');
    expect(windowsBuild).not.toContain("MACOS_CSC_LINK");

    expect(workflow).not.toContain(
      "Refresh Windows app bundle after portable helper rebuild",
    );
    expect(workflow.indexOf("Run display-sensitive Electron end-to-end tests"))
      .toBeGreaterThan(workflow.indexOf("Build the release application bundle once"));

    const linuxBuild = workflowStep(workflow, "Build Linux release package");
    expect(linuxBuild).toContain("if: runner.os == 'Linux'");
    expect(linuxBuild).toContain("PACKAGE_SCRIPT: ${{ matrix.package_script }}");
    expect(linuxBuild).not.toContain("_CSC_");
    expect(linuxBuild).not.toContain("APPLE_API_");

    const releaseUpload = workflowStep(
      workflow,
      "Upload without replacing existing assets",
    );
    expect(releaseUpload).toContain(
      'gh api --paginate -H "Cache-Control: no-cache"',
    );
    expect(releaseUpload).toContain(
      '"repos/$GITHUB_REPOSITORY/releases?per_page=100"',
    );
    expect(releaseUpload).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/releases/$release_id"',
    );
    expect(releaseUpload).toContain("load_release_by_tag_with_retry");
    expect(releaseUpload).toContain("for attempt in {1..7}; do");
    expect(releaseUpload).toContain('sleep "$delay"');
    expect(releaseUpload).toContain("RELEASE_VERIFY_REMOTE=1");
    expect(releaseUpload).toContain(
      'RELEASE_EXPECTED_COMMIT="$RELEASE_SOURCE_SHA"',
    );
    expect(releaseUpload.match(/^\s+revalidate_frozen_tag\s*$/gmu)).toHaveLength(3);
    const createRelease = releaseUpload.indexOf('gh release create "$RELEASE_TAG"');
    const uploadRelease = releaseUpload.indexOf('gh release upload "$RELEASE_TAG"');
    const editRelease = releaseUpload.indexOf('gh release edit "$RELEASE_TAG"');
    const revalidations = [...releaseUpload.matchAll(/^\s+revalidate_frozen_tag\s*$/gmu)]
      .map((match) => match.index);
    expect(revalidations[0]).toBeLessThan(createRelease);
    expect(revalidations[1]).toBeGreaterThan(createRelease);
    expect(revalidations[1]).toBeLessThan(uploadRelease);
    expect(revalidations[2]).toBeLessThan(editRelease);
    expect(revalidations[2]).toBeGreaterThan(uploadRelease);
    expect(releaseUpload).not.toContain("releases/tags/$RELEASE_TAG");
  });

  it("rejects a release tag moved after its commit identity was frozen", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "inertia-release-identity-"));
    const remote = await mkdtemp(join(tmpdir(), "inertia-release-remote-"));
    const tag = "v1.2.3";
    const gitEnvironment = {
      ...process.env,
      GIT_AUTHOR_EMAIL: "release-test@example.invalid",
      GIT_AUTHOR_NAME: "Release Test",
      GIT_COMMITTER_EMAIL: "release-test@example.invalid",
      GIT_COMMITTER_NAME: "Release Test",
    };
    const git = (...args: string[]): string => execFileSync("git", args, {
      cwd: fixture,
      encoding: "utf8",
      env: gitEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    try {
      await writeFile(join(fixture, "package.json"), JSON.stringify({ version: "1.2.3" }));
      await writeFile(join(fixture, "package-lock.json"), JSON.stringify({
        version: "1.2.3",
        packages: { "": { version: "1.2.3" } },
      }));
      git("init", "--quiet");
      git("add", "package.json", "package-lock.json");
      git("commit", "--quiet", "-m", "release source");
      git("tag", "--annotate", "--message", "release", tag);
      git("init", "--quiet", "--bare", remote);
      git("remote", "add", "origin", remote);
      git("push", "--quiet", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
      const frozenCommit = git("rev-parse", "HEAD^{commit}");
      const validator = join(repositoryRoot, "scripts/validate-release.mjs");
      const validatorEnvironment = {
        ...process.env,
        RELEASE_EVENT_SHA: frozenCommit,
        RELEASE_EXPECTED_COMMIT: frozenCommit,
        RELEASE_REF: `refs/tags/${tag}`,
        RELEASE_TAG: tag,
        RELEASE_VERIFY_REMOTE: "1",
      };
      const valid = spawnSync(process.execPath, [validator], {
        cwd: fixture,
        encoding: "utf8",
        env: validatorEnvironment,
      });
      expect(valid.status, valid.stderr).toBe(0);

      await writeFile(join(fixture, "moved-tag.txt"), "different commit\n");
      git("add", "moved-tag.txt");
      git("commit", "--quiet", "-m", "move release tag");
      const movedCommit = git("rev-parse", "HEAD^{commit}");
      git("push", "--quiet", "--force", "origin", `HEAD:refs/tags/${tag}`);
      git("checkout", "--quiet", "--detach", frozenCommit);

      const remotelyMoved = spawnSync(process.execPath, [validator], {
        cwd: fixture,
        encoding: "utf8",
        env: validatorEnvironment,
      });
      expect(remotelyMoved.status).not.toBe(0);
      expect(remotelyMoved.stderr).toContain(
        "the remote release tag no longer points to the frozen release commit",
      );

      git("push", "--quiet", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`);
      git("tag", "--force", tag, movedCommit);
      const locallyMoved = spawnSync(process.execPath, [validator], {
        cwd: fixture,
        encoding: "utf8",
        env: validatorEnvironment,
      });
      expect(locallyMoved.status).not.toBe(0);
      expect(locallyMoved.stderr).toContain(
        "the release tag no longer points to the frozen release commit",
      );
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(remote, { recursive: true, force: true });
    }
  });
});
