import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

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
    const directory = resolve("ci-test-timings");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `${phase}-${shard ? `${shard.current}-of-${shard.total}` : "all"}.json`),
      `${JSON.stringify(report)}\n`);
  }
}
