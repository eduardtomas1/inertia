import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";

const MAX_REPORTS_PER_PHASE = 16;

// Reporting only: no retries, outcome rewriting, trace changes or selection.
// Avoid serializing Playwright's config/environment, titles, errors, stdio and
// attachments; this artifact needs only identity, discovery and elapsed time.
export default class PlaywrightTimings {
  onBegin(config, suite) {
    this.config = config;
    this.tests = suite.allTests().map((test) => ({
      test,
      id: createHash("sha256").update(test.id).digest("hex"),
      project: test.parent.project().name,
      file: relative(config.rootDir, test.location.file).replaceAll("\\", "/"),
    }));
  }

  onEnd(result) {
    const projects = [...new Set(this.tests.map(({ project }) => project))].sort();
    const shard = this.config.shard;
    const phase = projects.join("+") || "empty";
    if (!/^[a-z0-9+-]{1,150}$/u.test(phase) || this.tests.length > 20_000) {
      throw new Error("Unexpected timing report scope.");
    }
    const report = {
      schemaVersion: 1,
      candidate: process.env.GITHUB_SHA ?? null,
      sourceHead: process.env.INERTIA_CI_SOURCE_HEAD ?? process.env.GITHUB_SHA ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      runnerOS: process.env.RUNNER_OS ?? null,
      runnerArch: process.env.RUNNER_ARCH ?? null,
      imageOS: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      projects, shard, status: result.status, elapsedMs: result.duration,
      discovered: this.tests.length,
      files: new Set(this.tests.map(({ project, file }) => `${project}:${file}`)).size,
      tests: this.tests.map(({ test, ...identity }) => ({
        ...identity, expectedStatus: test.expectedStatus, outcome: test.outcome(),
        attempts: test.results.map(({ retry, status, duration }) => ({ retry, status, durationMs: duration })),
      })),
    };
    // config.rootDir is the resolved testDir (tests/e2e), not the workspace.
    // CI uploads ci-test-timings/*.json from beside the config file.
    const workspace = this.config.configFile ? dirname(this.config.configFile) : process.cwd();
    const directory = resolve(workspace, "ci-test-timings");
    mkdirSync(directory, { recursive: true });
    const stem = `${phase}-${shard ? `${shard.current}-of-${shard.total}` : "all"}`;
    const body = `${JSON.stringify(report)}\n`;
    // A job may run the same project twice (a filtered smoke, then the full
    // suite). Each invocation keeps its own report instead of replacing the
    // previous one; exclusive creation makes the second write pick a new name.
    for (let attempt = 1; attempt <= MAX_REPORTS_PER_PHASE; attempt += 1) {
      const path = resolve(directory, attempt === 1 ? `${stem}.json` : `${stem}-${attempt}.json`);
      try {
        writeFileSync(path, body, { flag: "wx" });
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new Error("Too many timing reports for one phase.");
  }
}
