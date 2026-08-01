import "./styles.css";

import type {
  RemoteSafeActivity,
  RemoteSafeConversationDetail,
  RemoteSafeMessage,
  RemoteSafeShell,
  RemoteSafeSubagent,
} from "../../../src/shared/remote-protocol";
import type { RemoteConnectionSnapshot } from "./connection-supervisor";
import { RemoteCompanionClient } from "./remote-client";
import { appendRemoteText, button } from "./safe-dom";

const root = document.querySelector<HTMLElement>("#app")!;
if (!root) throw new Error("Remote Companion root is missing.");

let shell: RemoteSafeShell | null = null;
let detail: RemoteSafeConversationDetail | null = null;
let status = "Starting…";
let online = false;
let connection: RemoteConnectionSnapshot | null = null;
let pairingCode: string | null = null;
let promptStatus: { message: string; uncertain: boolean } | null = null;
let pairing = false;
let hadProfile = false;
let sending = false;
let promptConversationId: string | null = null;

const header = document.createElement("header");
const title = document.createElement("h1");
title.textContent = "Inertia Remote Companion";
const headerStatus = document.createElement("div");
const statusLine = appendRemoteText(headerStatus, status, "status offline");
statusLine.setAttribute("role", "status");
statusLine.setAttribute("aria-live", "polite");
const updatedLine = appendRemoteText(headerStatus, "", "updated");
header.append(title, headerStatus);

const pairingView = createPairingView();
const profileView = createProfileView();
const empty = appendRemoteText(root, "No live desktop state is available.", "empty");
const layout = document.createElement("div");
layout.className = "layout";
const navigation = document.createElement("nav");
navigation.setAttribute("aria-label", "Conversations");
const conversation = createConversationView();
layout.append(navigation, conversation.root);
root.prepend(header, pairingView.root, profileView.root);
root.append(layout);

const projectViews = new Map<string, {
  root: HTMLElement;
  heading: HTMLHeadingElement;
  conversations: Map<string, HTMLButtonElement>;
}>();
const messageViews = new Map<string, {
  root: HTMLElement;
  role: HTMLElement;
  content: HTMLElement;
}>();
const activityViews = new Map<string, HTMLElement>();
const subagentViews = new Map<string, HTMLElement>();

const client = new RemoteCompanionClient({
  status: (message, isOnline) => {
    status = message;
    online = isOnline;
    render();
  },
  connection: (value) => {
    connection = value;
    render();
  },
  invalidated: () => {
    shell = null;
    detail = null;
    promptConversationId = null;
    promptStatus = null;
    render();
  },
  pairingCode: (code) => {
    pairingCode = code;
    pairing = true;
    render();
  },
  shell: (value) => {
    shell = value;
    render();
  },
  detail: (value) => {
    detail = value;
    if (value === null && !promptStatus?.uncertain) promptStatus = null;
    render();
  },
  promptResult: (message, uncertain) => {
    promptStatus = { message, uncertain };
    render();
  },
});

void client.initialize().then(
  () => render(),
  (error: unknown) => {
    status = error instanceof Error
      ? error.message
      : "The stored Remote Companion profile could not be opened.";
    render();
  },
);

function render(): void {
  const profile = client.currentProfile();
  const hasProfile = profile !== null;
  if (hadProfile && !hasProfile) {
    pairing = false;
    pairingCode = null;
  }
  hadProfile = hasProfile;
  root.classList.toggle("is-stale", !online && shell !== null);
  statusLine.textContent = status;
  statusLine.className = `status ${online ? "online" : "offline"}`;
  const lastUpdated = detail?.generatedAt ?? shell?.generatedAt ?? null;
  updatedLine.textContent = lastUpdated
    ? `${online ? "Last updated" : "Cached · last updated"} ${new Date(lastUpdated).toLocaleString()}`
    : "";
  updatedLine.hidden = lastUpdated === null;

  pairingView.root.hidden = hasProfile;
  profileView.root.hidden = !profile;
  if (!profile) {
    renderPairing();
    empty.hidden = true;
    layout.hidden = true;
    return;
  }

  profileView.heading.textContent = profile.deviceLabel;
  profileView.permissions.textContent =
    `Permissions: ${profile.scopes.join(", ")} · expires ${new Date(profile.expiresAt).toLocaleString()}`;
  profileView.reconnect.disabled = navigator.onLine === false
    || connection?.phase === "connecting";
  profileView.reconnect.textContent = connection?.phase === "terminal"
    ? "Retry connection"
    : connection?.phase === "connecting"
      ? "Connecting…"
      : "Reconnect";

  empty.hidden = shell !== null;
  layout.hidden = shell === null;
  if (!shell) return;
  renderNavigation(shell);
  renderDetail(detail, profile.scopes.includes("prompt"));
}

function createPairingView(): {
  root: HTMLElement;
  name: HTMLInputElement;
  invitation: HTMLTextAreaElement;
  submit: HTMLButtonElement;
  code: HTMLElement;
} {
  const section = document.createElement("section");
  section.className = "card pair";
  const heading = document.createElement("h2");
  heading.textContent = "Pair this browser";
  section.append(heading);
  appendRemoteText(
    section,
    "On the desktop, enable Remote Companion and create a five-minute invitation. Compare the six-digit code before approving.",
    "muted",
  );
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Browser name";
  const name = document.createElement("input");
  name.id = "remote-device-name";
  name.maxLength = 80;
  name.value = navigator.userAgent.includes("Mobile")
    ? "Mobile browser"
    : "Web browser";
  nameLabel.append(name);
  const invitationLabel = document.createElement("label");
  invitationLabel.textContent = "Invitation";
  const invitation = document.createElement("textarea");
  invitation.id = "remote-invitation-input";
  invitation.rows = 8;
  invitation.spellcheck = false;
  invitationLabel.append(invitation);
  const submit = button("Pair", () => {
    if (pairing || navigator.onLine === false) return;
    pairing = true;
    render();
    void client.pair(invitation.value, name.value).then(() => {
      invitation.value = "";
      pairing = false;
      pairingCode = null;
      render();
    }, (error: unknown) => {
      status = error instanceof Error ? error.message : "Pairing failed.";
      pairing = false;
      render();
    });
  });
  const code = appendRemoteText(section, "", "pairing-code");
  code.setAttribute("role", "status");
  section.append(nameLabel, invitationLabel, submit);
  return { root: section, name, invitation, submit, code };
}

function renderPairing(): void {
  pairingView.submit.disabled = pairing || navigator.onLine === false;
  pairingView.submit.textContent = pairing ? "Waiting for desktop…" : "Pair";
  pairingView.code.textContent = pairingCode
    ? `Comparison code: ${pairingCode}`
    : "";
  pairingView.code.hidden = pairingCode === null;
}

function createProfileView(): {
  root: HTMLElement;
  heading: HTMLHeadingElement;
  permissions: HTMLElement;
  reconnect: HTMLButtonElement;
} {
  const section = document.createElement("section");
  section.className = "card";
  const heading = document.createElement("h2");
  const permissions = appendRemoteText(section, "", "muted");
  const reconnect = button("Reconnect", () => void client.connect());
  const forget = button("Forget this browser", () => {
    void client.forget().then(() => location.reload());
  }, "secondary");
  section.prepend(heading);
  section.append(reconnect, forget);
  return { root: section, heading, permissions, reconnect };
}

function createConversationView(): {
  root: HTMLElement;
  heading: HTMLHeadingElement;
  meta: HTMLElement;
  stale: HTMLElement;
  waiting: HTMLElement;
  transcript: HTMLElement;
  activities: HTMLDetailsElement;
  activitySummary: HTMLElement;
  activityList: HTMLElement;
  subagents: HTMLDetailsElement;
  subagentSummary: HTMLElement;
  subagentList: HTMLElement;
  promptInfo: HTMLElement;
  safety: HTMLElement;
  form: HTMLFormElement;
  prompt: HTMLTextAreaElement;
  submit: HTMLButtonElement;
  result: HTMLElement;
  empty: HTMLElement;
} {
  const section = document.createElement("section");
  section.className = "conversation";
  const heading = document.createElement("h2");
  const meta = appendRemoteText(section, "", "muted");
  const stale = appendRemoteText(
    section,
    "Showing cached desktop data. Remote actions are disabled until the connection recovers.",
    "warning stale-notice",
  );
  const waiting = appendRemoteText(section, "", "warning");
  const transcript = document.createElement("div");
  transcript.className = "transcript";
  const activities = document.createElement("details");
  const activitySummary = document.createElement("summary");
  const activityList = document.createElement("div");
  activities.append(activitySummary, activityList);
  const subagents = document.createElement("details");
  const subagentSummary = document.createElement("summary");
  const subagentList = document.createElement("div");
  subagents.append(subagentSummary, subagentList);
  const promptInfo = appendRemoteText(section, "", "muted");
  const safety = appendRemoteText(section, "", "muted");
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = "Text prompt";
  const prompt = document.createElement("textarea");
  prompt.id = "remote-prompt-input";
  prompt.rows = 4;
  prompt.maxLength = 8_000;
  label.append(prompt);
  const submit = document.createElement("button");
  submit.type = "submit";
  form.append(label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = promptConversationId;
    const content = prompt.value;
    if (!target || !content.trim() || sending || !online) return;
    sending = true;
    promptStatus = null;
    render();
    void client.sendPrompt(target, content).then((accepted) => {
      if (accepted && promptConversationId === target) prompt.value = "";
    }, () => {
      promptStatus = {
        message: "Delivery is uncertain. The prompt was not retried.",
        uncertain: true,
      };
    }).finally(() => {
      sending = false;
      render();
    });
  });
  const result = appendRemoteText(section, "", "status");
  result.setAttribute("role", "status");
  result.setAttribute("aria-live", "polite");
  const emptyState = appendRemoteText(section, "Choose a conversation.", "empty");
  section.prepend(heading);
  section.append(
    transcript,
    activities,
    subagents,
    form,
    result,
    emptyState,
  );
  return {
    root: section,
    heading,
    meta,
    stale,
    waiting,
    transcript,
    activities,
    activitySummary,
    activityList,
    subagents,
    subagentSummary,
    subagentList,
    promptInfo,
    safety,
    form,
    prompt,
    submit,
    result,
    empty: emptyState,
  };
}

function renderNavigation(value: RemoteSafeShell): void {
  const liveProjects = new Set(value.projects.map(({ id }) => id));
  for (const [id, view] of projectViews) {
    if (liveProjects.has(id)) continue;
    view.root.remove();
    projectViews.delete(id);
  }
  for (const project of value.projects) {
    let view = projectViews.get(project.id);
    if (!view) {
      const projectRoot = document.createElement("section");
      projectRoot.dataset.remoteKey = `project:${project.id}`;
      const heading = document.createElement("h2");
      projectRoot.append(heading);
      view = { root: projectRoot, heading, conversations: new Map() };
      projectViews.set(project.id, view);
    }
    view.heading.textContent = project.name;
    const items = value.conversations.filter(
      ({ projectId }) => projectId === project.id,
    );
    const liveConversations = new Set(items.map(({ id }) => id));
    for (const [id, node] of view.conversations) {
      if (liveConversations.has(id)) continue;
      node.remove();
      view.conversations.delete(id);
    }
    for (const item of items) {
      let node = view.conversations.get(item.id);
      if (!node) {
        node = button("", () => client.selectConversation(item.id));
        node.dataset.remoteKey = `conversation:${item.id}`;
        view.conversations.set(item.id, node);
      }
      node.textContent = `${item.title} · ${item.status}`;
      node.className = detail?.conversation.id === item.id ? "selected" : "";
      view.root.append(node);
    }
    navigation.append(view.root);
  }
}

function renderDetail(
  value: RemoteSafeConversationDetail | null,
  canPrompt: boolean,
): void {
  conversation.empty.hidden = value !== null;
  conversation.heading.hidden = value === null;
  conversation.meta.hidden = value === null;
  conversation.stale.hidden = value === null || online;
  conversation.waiting.hidden = value === null || !value.waitingForLocalAction;
  conversation.transcript.hidden = value === null;
  conversation.activities.hidden = !value || value.activities.length === 0;
  conversation.subagents.hidden = !value || value.subagents.length === 0;
  conversation.form.hidden = true;
  conversation.promptInfo.hidden = true;
  conversation.safety.hidden = true;
  conversation.result.hidden = !promptStatus || value === null;
  if (!value) {
    promptConversationId = null;
    return;
  }

  const changedConversation = promptConversationId !== value.conversation.id;
  conversation.heading.textContent = value.conversation.title;
  conversation.meta.textContent =
    `${value.conversation.providerLabel} · ${value.conversation.status}`;
  conversation.waiting.textContent = value.waitingForLocalAction
    ? "This run is waiting for an action on the desktop. Remote approvals and secret answers are unavailable."
    : "";
  updateTranscript(value.messages);
  reconcileTextItems(
    conversation.activityList,
    activityViews,
    value.activities,
    (activity) => activity.id,
    (activity) => `${activity.title} · ${activity.status}`,
  );
  conversation.activitySummary.textContent =
    `Safe workstream (${value.activities.length})`;
  reconcileTextItems(
    conversation.subagentList,
    subagentViews,
    value.subagents,
    (subagent) => subagent.id,
    (subagent) =>
      `${subagent.name ?? "Agent"} · ${subagent.providerLabel} · ${subagent.status}`,
  );
  conversation.subagentSummary.textContent =
    `Delegated agents (${value.subagents.length})`;

  promptConversationId = value.conversation.id;
  if (changedConversation) conversation.prompt.value = "";
  const safety = value.conversation.promptSafety;
  if (!canPrompt) {
    conversation.promptInfo.hidden = false;
    conversation.promptInfo.textContent =
      "This device is view-only. Prompting must be enabled on the desktop.";
  } else if (!safety.supported) {
    conversation.promptInfo.hidden = false;
    conversation.safety.hidden = false;
    conversation.promptInfo.textContent =
      `${value.conversation.providerLabel} remote prompt unavailable`;
    conversation.safety.textContent = safety.explanation;
  } else {
    conversation.promptInfo.hidden = false;
    conversation.safety.hidden = false;
    conversation.form.hidden = false;
    conversation.promptInfo.textContent =
      `${value.conversation.providerLabel} remote prompt`;
    conversation.safety.textContent = safety.headline;
    conversation.submit.disabled = sending || !online;
    conversation.prompt.disabled = !online;
    conversation.submit.textContent = sending
      ? "Sending…"
      : online
        ? "Send to desktop"
        : "Offline";
  }
  if (promptStatus) {
    conversation.result.textContent = promptStatus.message;
    conversation.result.className = promptStatus.uncertain
      ? "warning"
      : "status";
  }
}

function updateTranscript(messages: RemoteSafeMessage[]): void {
  const previousTop = conversation.transcript.scrollTop;
  const followedLatest = conversation.transcript.scrollHeight
    - conversation.transcript.clientHeight
    - previousTop <= 8;
  const live = new Set(messages.map(({ id }) => id));
  for (const [id, view] of messageViews) {
    if (live.has(id)) continue;
    view.root.remove();
    messageViews.delete(id);
  }
  for (const message of messages) {
    let view = messageViews.get(message.id);
    if (!view) {
      const article = document.createElement("article");
      article.dataset.remoteKey = `message:${message.id}`;
      const role = appendRemoteText(article, "", "role");
      const content = appendRemoteText(article, "", "message-content");
      view = { root: article, role, content };
      messageViews.set(message.id, view);
    }
    view.root.className = `message ${message.role}`;
    view.role.textContent = message.role === "user" ? "You" : "Agent";
    view.content.textContent = message.content;
    conversation.transcript.append(view.root);
  }
  conversation.transcript.scrollTop = followedLatest
    ? Math.max(0, conversation.transcript.scrollHeight
      - conversation.transcript.clientHeight)
    : previousTop;
}

function reconcileTextItems<T extends RemoteSafeActivity | RemoteSafeSubagent>(
  parent: HTMLElement,
  views: Map<string, HTMLElement>,
  values: T[],
  key: (value: T) => string,
  text: (value: T) => string,
): void {
  const live = new Set(values.map(key));
  for (const [id, node] of views) {
    if (live.has(id)) continue;
    node.remove();
    views.delete(id);
  }
  for (const value of values) {
    const id = key(value);
    let node = views.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "activity";
      node.dataset.remoteKey = id;
      views.set(id, node);
    }
    node.textContent = text(value);
    parent.append(node);
  }
}
