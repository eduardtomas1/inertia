import { readFile } from "node:fs/promises";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: node scripts/summarize-startup-profile.mjs <startup-profile.json>...");
  process.exit(1);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function flatten(record) {
  const origin = record.launchRequestedAt;
  const points = {};
  const put = (name, epochMs) => {
    if (typeof epochMs === "number" && Number.isFinite(epochMs)) points[name] = epochMs - origin;
  };
  for (const [name, value] of Object.entries(record.harness ?? {})) {
    if (name !== "quietWaitMs") points[`harness:${name}`] = value;
  }
  const metrics = record.appMetrics;
  if (metrics) {
    put("metrics:main-created", metrics.mainCreationTime);
    for (const metric of metrics.metrics ?? []) {
      const label = metric.serviceName ? `${metric.type}:${metric.serviceName}` : metric.type;
      if (["Browser", "Tab", "GPU", "Utility"].includes(metric.type)) put(`metrics:${label}-created`, metric.creationTime);
    }
  }
  const main = record.mainMarks;
  if (main) {
    put("main:process-created", main.facts?.processCreationTime);
    put("main:time-origin", main.timeOrigin);
    for (const [name, at] of main.marks) put(name === "module" ? "main:marks-module" : name, at);
    const renderer = main.renderer;
    if (renderer && !record.renderer) record.renderer = renderer;
  }
  const worker = record.workerMarks;
  if (worker) {
    put("worker:time-origin", worker.timeOrigin);
    for (const [name, at] of worker.marks) put(name === "module" ? "worker:marks-module" : name, at);
  }
  const renderer = record.renderer;
  if (renderer && !renderer.error) {
    const origin2 = renderer.timeOrigin;
    put("renderer:time-origin", origin2);
    const navigation = renderer.navigation?.[0];
    if (navigation) {
      for (const key of ["responseEnd", "domInteractive", "domContentLoadedEventEnd", "loadEventEnd"]) {
        put(`renderer:nav:${key}`, origin2 + navigation[key]);
      }
    }
    for (const paint of renderer.paint ?? []) put(`renderer:${paint.name}`, origin2 + paint.startTime);
    const observer = renderer.observer;
    if (observer) {
      put("renderer:observer-installed", observer.installedAt);
      for (const [name, at] of Object.entries(observer.seen ?? {})) put(`renderer:seen:${name}`, at);
      for (const [name, value] of Object.entries(observer.painted ?? {})) put(`renderer:painted:${name}`, value.frame);
      const socket = observer.sockets?.[0];
      if (socket) {
        put("renderer:ws-created", socket.createdAt);
        put("renderer:ws-open", socket.openedAt);
        const welcome = socket.messages?.find((message) => message.type === "server.welcome");
        put("renderer:ws-welcome", welcome?.at);
        const detail = socket.messages?.find((message, index) => index > 0 && message.type === "request.result" && message.bytes > 1_000);
        put("renderer:ws-detail-result", detail?.at);
      }
      const lcp = observer.lcp?.at(-1);
      put("renderer:lcp-last", lcp?.at);
    }
  }
  return points;
}

for (const path of paths) {
  const report = JSON.parse(await readFile(path, "utf8"));
  console.log(`# ${path}`);
  console.log(`label=${report.label} mode=${report.mode} runs=${report.runs} seed=${JSON.stringify(report.seed)} databaseBytes=${report.templateDatabaseBytes}`);
  for (const temperature of ["cold", "warm"]) {
    const records = report.records.filter((record) => record.temperature === temperature);
    if (records.length === 0) continue;
    const flattened = records.map(flatten);
    const names = new Set(flattened.flatMap((points) => Object.keys(points)));
    const rows = [...names].map((name) => {
      const values = flattened.map((points) => points[name]).filter((value) => typeof value === "number");
      return { name, n: values.length, median: median(values), p95: percentile(values, 0.95), values };
    }).sort((left, right) => left.median - right.median);
    const loads = records.map((record) => `${record.loadBefore[0].toFixed(2)}->${record.loadAfter[0].toFixed(2)}`).join(" ");
    console.log(`\n## ${temperature} (n=${records.length}) load1 ${loads}`);
    console.log("| point | median ms | p95 ms | raw |");
    console.log("|---|---:|---:|---|");
    for (const row of rows) {
      console.log(`| ${row.name} | ${row.median.toFixed(1)} | ${row.p95.toFixed(1)} | ${row.values.map((value) => value.toFixed(0)).join(", ")} |`);
    }
    const welcome = records.map((record) => record.welcome?.bytes ?? record.renderer?.observer?.sockets?.[0]?.messages?.find((message) => message.type === "server.welcome")?.bytes).filter(Boolean);
    if (welcome.length) console.log(`\nwelcome bytes: ${welcome.join(", ")}; gzip: ${records.map((record) => record.welcome?.gzipBytes ?? "-").join(", ")}`);
    const longTasks = records.map((record) => {
      const tasks = record.renderer?.observer?.longTasks ?? [];
      return `${tasks.length}/${tasks.reduce((sum, task) => sum + task.duration, 0).toFixed(0)}ms/max ${tasks.reduce((max, task) => Math.max(max, task.duration), 0).toFixed(0)}`;
    });
    console.log(`renderer long tasks (count/total/max): ${longTasks.join("; ")}`);
  }
  console.log("");
}
