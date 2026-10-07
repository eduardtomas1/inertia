import { join } from "node:path";

import { RuntimeStore } from "../../../src/server/database";
import { providerNativeModelSelection } from "../../../src/shared/model-routing";

export const HTML_RENDER_TITLE = "Treatment A: settled row";
export const HTML_RENDER_TABLE_TITLE = "Treatment comparison";
export const HTML_RENDER_HEADING = "Settled row, treatment A";
export const HTML_RENDER_LINK = "https://example.com/docs";
export const HTML_RENDER_ANSWER =
  "Treatment A keeps a finished turn to a single 36 px line, so a long chat scans in about a third less time. "
  + "I would ship A and fold B's right-aligned duration into it as a follow-up.";

// A product mock styled only with the theme variables Inertia injects, so the
// page follows the app's light and dark appearance without its own colors.
export const SETTLED_ROW_PAGE = `<!doctype html>
<html lang="en">
<head>
<title>Settled row</title>
<style>
  body { padding: 2px 0 4px; }
  h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--foreground); }
  .lede { margin: 0 0 14px; color: var(--muted-foreground); font-size: 13px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
  @media (max-width: 620px) { .grid { grid-template-columns: minmax(0, 1fr); } }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; min-width: 0; }
  .label { margin: 0 0 10px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
  .row { display: flex; align-items: center; gap: 8px; height: 36px; border-top: 1px solid var(--border); font-size: 13px; }
  .row:first-of-type { border-top: 0; }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
  .dot.idle { background: var(--muted-foreground); opacity: .5; }
  .row b { font-weight: 600; white-space: nowrap; }
  .row span { color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row time { flex: none; margin-left: auto; padding-left: 8px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; white-space: nowrap; }
  svg { display: block; width: 100%; height: 112px; }
  .bar { fill: var(--muted-foreground); opacity: .35; }
  .bar.pick { fill: var(--accent); opacity: 1; }
  .axis { stroke: var(--border); }
  .tick { fill: var(--muted-foreground); font: 11px var(--font-sans); }
  .value { fill: var(--foreground); font: 600 11px var(--font-sans); }
  .stat { margin: 2px 0 2px; font-size: 30px; font-weight: 650; letter-spacing: -.02em; color: var(--accent); }
  .note { margin: 0 0 12px; color: var(--muted-foreground); font-size: 12.5px; }
  a { color: var(--accent); text-decoration: none; font-size: 13px; font-weight: 500; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h2>${HTML_RENDER_HEADING}</h2>
  <p class="lede">A finished turn collapses to one quiet line; the work log stays one click away.</p>
  <div class="grid">
    <section class="card" aria-label="Row anatomy">
      <p class="label">Row anatomy</p>
      <div class="row"><i class="dot"></i><b>Settled</b><span>6 files read, 3 commands</span><time>42s</time></div>
      <div class="row"><i class="dot"></i><b>Settled</b><span>Edited model.ts</span><time>1m 08s</time></div>
      <div class="row"><i class="dot idle"></i><b>Cancelled</b><span>Stopped by you</span><time>9s</time></div>
    </section>
    <section class="card" aria-label="Row height by treatment">
      <p class="label">Row height</p>
      <svg viewBox="0 0 180 112" role="img" aria-label="Row height: A 36px, B 48px, C 56px">
        <line class="axis" x1="0" y1="92" x2="180" y2="92" />
        <rect class="bar pick" x="12" y="47" width="44" height="45" rx="4" />
        <rect class="bar" x="68" y="32" width="44" height="60" rx="4" />
        <rect class="bar" x="124" y="22" width="44" height="70" rx="4" />
        <text class="value" x="34" y="40" text-anchor="middle">36px</text>
        <text class="value" x="90" y="25" text-anchor="middle">48px</text>
        <text class="value" x="146" y="15" text-anchor="middle">56px</text>
        <text class="tick" x="34" y="108" text-anchor="middle">A</text>
        <text class="tick" x="90" y="108" text-anchor="middle">B</text>
        <text class="tick" x="146" y="108" text-anchor="middle">C</text>
      </svg>
    </section>
    <section class="card" aria-label="Scan cost">
      <p class="label">Scan cost</p>
      <p class="stat">&minus;38%</p>
      <p class="note">Time to find the last answer in a 40-turn chat, against today's expanded rows.</p>
      <a href="${HTML_RENDER_LINK}">Row guidelines &rarr;</a>
    </section>
  </div>
</body>
</html>`;

export const COMPARISON_TABLE_PAGE = `<!doctype html>
<html lang="en">
<head>
<style>
  table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-weight: 600; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); padding: 0 12px 8px 0; }
  td { padding: 8px 12px 8px 0; border-top: 1px solid var(--border); }
  td.pick { color: var(--accent); font-weight: 600; }
  td.muted { color: var(--muted-foreground); }
</style>
</head>
<body>
  <table>
    <thead><tr><th>Treatment</th><th>Row height</th><th>Lines per turn</th><th>Verdict</th></tr></thead>
    <tbody>
      <tr><td class="pick">A &middot; settled row</td><td>36px</td><td>1</td><td class="pick">Ship</td></tr>
      <tr><td>B &middot; timed row</td><td>48px</td><td>1&ndash;2</td><td class="muted">Fold duration into A</td></tr>
      <tr><td>C &middot; summary card</td><td>56px</td><td>3</td><td class="muted">Too heavy</td></tr>
    </tbody>
  </table>
</body>
</html>`;

export const HOSTILE_PAGE_TITLE = "Hostile page";
export const HOSTILE_PAGE_LINK = "https://example.com/clicked";
export const SCOPED_PAGE_TITLE = "Scoped page";
export const FOREIGN_PAGE_TITLE = "Foreign page";

const FORGED_TOKEN = "0".repeat(32);

export const HOSTILE_PAGE = `<!doctype html>
<html lang="en">
<head><title>Hostile</title></head>
<body>
  <h2>${HOSTILE_PAGE_TITLE}</h2>
  <p><a id="real" href="${HOSTILE_PAGE_LINK}">Real link</a></p>
  <p><button id="fake" type="button">Not a link</button></p>
  <p><input id="secret" aria-label="Access token"></p>
  <script>
    window.__inertiaE2eMarker = "kept";
    const post = (message) => parent.postMessage(message, "*");
    post({ type: "inertia-html-render:hello", token: "${FORGED_TOKEN}" });
    const forge = (url) => {
      post({ type: "inertia-html-render:open-link", url });
      post({ type: "inertia-html-render:open-link", url, token: "${FORGED_TOKEN}" });
    };
    document.getElementById("fake").addEventListener("click", () => forge("https://example.com/forged-click"));
    document.getElementById("real").addEventListener("click", () => forge("https://example.com/forged-second"));
    document.getElementById("secret").addEventListener("keydown", (event) => {
      if (event.key === "Enter") forge("https://example.com/?t=" + encodeURIComponent(event.target.value));
    });
  </script>
</body>
</html>`;

function simplePage(heading: string): string {
  return `<!doctype html><html lang="en"><head><title>${heading}</title></head><body><h2>${heading}</h2></body></html>`;
}

interface SeededPage {
  title: string;
  html: string;
  height: number;
}

function openStore(testDirectory: string, workspaceDirectory: string): RuntimeStore {
  return new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
}

function seedTurnWithPages(
  store: RuntimeStore,
  conversationId: string,
  runId: string,
  pages: readonly SeededPage[],
  answer: string,
): string[] {
  const selection = providerNativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5.6",
    alias: "GPT-5.6",
    reasoningEffort: "high",
  });
  const requestedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const startedAt = new Date(Date.parse(requestedAt) + 2_000).toISOString();
  const { turn } = store.beginAgentTurn({
    conversationId,
    runId,
    content: "Mock the settled row treatment and compare it with the other two options.",
    providerId: "codex",
    modelSelection: selection,
    reasoningEffort: selection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: selection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt,
  });
  store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt, updatedAt: startedAt });
  const at = (seconds: number): string => new Date(Date.parse(startedAt) + seconds * 1_000).toISOString();
  const renderIds = pages.map((page, index) => store.htmlRenders.create({
    conversationId, runId: turn.runId, turnId: turn.id,
    title: page.title, html: page.html, height: page.height, createdAt: at(30 + index * 4),
  }).renderId);
  const completedAt = at(42);
  const message = store.createMessage(conversationId, answer, "assistant", [], turn.id, completedAt);
  store.updateAgentTurnLifecycle(turn.id, {
    status: "completed",
    completedAt,
    updatedAt: completedAt,
    terminalAssistantMessageId: message.id,
    terminalReason: "provider-completed",
  });
  return renderIds;
}

function activeConversationId(store: RuntimeStore): string {
  const conversationId = store.shellSnapshot().activeConversationId;
  if (!conversationId) throw new Error("The visual reply fixture needs a seeded conversation.");
  return conversationId;
}

/** Seeds one completed turn with two visual replies above its final answer, in dark mode. */
export function seedHtmlRenderConversation({
  testDirectory,
  workspaceDirectory,
}: {
  testDirectory: string;
  workspaceDirectory: string;
}): void {
  const store = openStore(testDirectory, workspaceDirectory);
  try {
    const conversationId = activeConversationId(store);
    store.updateSettings({ theme: "dark", interfaceScale: "default", responseDensity: "default" });
    seedTurnWithPages(store, conversationId, "html-render-e2e-run", [
      { title: HTML_RENDER_TITLE, html: SETTLED_ROW_PAGE, height: 320 },
      { title: HTML_RENDER_TABLE_TITLE, html: COMPARISON_TABLE_PAGE, height: 160 },
    ], HTML_RENDER_ANSWER);
  } finally {
    store.close();
  }
}

/** Seeds one completed turn whose only visual reply tries to act on the app by itself. */
export function seedHostileHtmlRenderConversation({
  testDirectory,
  workspaceDirectory,
}: {
  testDirectory: string;
  workspaceDirectory: string;
}): void {
  const store = openStore(testDirectory, workspaceDirectory);
  try {
    seedTurnWithPages(store, activeConversationId(store), "html-render-hostile-run", [
      { title: HOSTILE_PAGE_TITLE, html: HOSTILE_PAGE, height: 240 },
    ], HTML_RENDER_ANSWER);
  } finally {
    store.close();
  }
}

/** Seeds a page in the active chat and another in a second chat; returns both render ids. */
export function seedScopedHtmlRenderConversations({
  testDirectory,
  workspaceDirectory,
}: {
  testDirectory: string;
  workspaceDirectory: string;
}): { scopedRenderId: string; foreignRenderId: string } {
  const store = openStore(testDirectory, workspaceDirectory);
  try {
    const conversationId = activeConversationId(store);
    const projectId = store.conversation(conversationId).projectId;
    const other = store.createConversation(projectId, "Other chat", { activate: false });
    const [foreignRenderId] = seedTurnWithPages(store, other.id, "html-render-foreign-run", [
      { title: FOREIGN_PAGE_TITLE, html: simplePage(FOREIGN_PAGE_TITLE), height: 160 },
    ], HTML_RENDER_ANSWER);
    const [scopedRenderId] = seedTurnWithPages(store, conversationId, "html-render-scoped-run", [
      { title: SCOPED_PAGE_TITLE, html: simplePage(SCOPED_PAGE_TITLE), height: 160 },
    ], HTML_RENDER_ANSWER);
    return { scopedRenderId: scopedRenderId!, foreignRenderId: foreignRenderId! };
  } finally {
    store.close();
  }
}
