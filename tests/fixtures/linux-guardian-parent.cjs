const { spawn, spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const { statSync } = require("node:fs");

const [guardian, payload, descendantPidPath, guardianPidPath] = process.argv.slice(2);
const guardianIdentity = statSync(guardian, { bigint: true });
const child = spawn(
  guardian,
  [
    "watch", String(process.pid), String(guardianIdentity.dev), String(guardianIdentity.ino),
    // Keep the direct owned payload alive until this runtime-parent harness
    // exits. Otherwise the guardian can correctly drain a fast-exiting root
    // before the double-forked descendant records the identity this test needs.
    "--", payload, descendantPidPath, "keep-root",
  ],
  { detached: true, stdio: "ignore" },
);
writeFileSync(guardianPidPath, String(child.pid));
const timer = setInterval(() => {
  const ready = spawnSync(guardian, ["ready", String(child.pid)], {
    stdio: "ignore",
    timeout: 100,
  });
  if (ready.status !== 0) return;
  const identity = spawnSync(guardian, ["identity", String(child.pid)], { encoding: "utf8" });
  const start = identity.stdout.trim().split("|")[3];
  const common = [
    "signal", String(child.pid), start,
    String(guardianIdentity.dev), String(guardianIdentity.ino),
  ];
  if (spawnSync(guardian, [...common, "claim"], { stdio: "ignore" }).status !== 0) process.exit(2);
  if (spawnSync(guardian, [...common, "exec"], { stdio: "ignore" }).status !== 0) process.exit(3);
  clearInterval(timer);
  // The ARM64 coverage lane can spend several seconds scheduling this
  // detached native payload while the instrumented suite is saturated.
  // This deadline protects only the test harness; the guardian's production
  // lifecycle bounds remain unchanged.
  const readinessDeadline = Date.now() + 15_000;
  const readiness = setInterval(() => {
    if (existsSync(descendantPidPath)) {
      clearInterval(readiness);
      process.exit(0);
    }
    if (Date.now() >= readinessDeadline) {
      clearInterval(readiness);
      process.exit(4);
    }
  }, 10);
}, 10);
