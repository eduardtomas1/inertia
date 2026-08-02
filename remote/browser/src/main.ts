import "./styles.css";

import type {
  RemoteSafeActivity,
  RemoteSafeConversationDetail,
  RemoteSafeMessage,
  RemoteSafeShell,
  RemoteSafeSubagent,
} from "../../../src/shared/remote-protocol";
import { parseRemotePairingFragment } from "../../../src/shared/remote-pairing-link";
import type { RemoteConnectionSnapshot } from "./connection-supervisor";
import { RemoteCompanionClient } from "./remote-client";
import { appendRemoteText, button } from "./safe-dom";

const root = document.querySelector<HTMLElement>("#app")!;
if (!root) throw new Error("Remote Companion root is missing.");

const initialPairingFragment = window.location.hash;
let initialInvitationText = "";
let pairingLinkMessage = "";
if (initialPairingFragment.startsWith("#pair=")) {
  // Clear the secret-bearing fragment before parsing or rendering it. Fragments
  // are not sent in HTTP requests; removing it also prevents later referrers,
  // screenshots, and copied address bars from retaining invitation material.
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  try {
    const invitation = parseRemotePairingFragment(initialPairingFragment);
    initialInvitationText = invitation ? JSON.stringify(invitation) : "";
    pairingLinkMessage = invitation
      ? "Secure invitation loaded from this device-only link. Name the browser, then pair."
      : "";
  } catch {
    pairingLinkMessage = "This pairing link is invalid or expired. Create a new invitation on the desktop.";
  }
}

let shell: RemoteSafeShell | null = null;
let detail: RemoteSafeConversationDetail | null = null;
let shellCheckedAt: string | null = null;
let detailCheckedAt: string | null = null;
let status = "Starting…";
let online = false;
let connection: RemoteConnectionSnapshot | null = null;
let pairingCode: string | null = null;
let promptStatus: { message: string; uncertain: boolean } | null = null;
let pairing = false;
let hadProfile = false;
let sending = false;
let sendOperation = 0;
let sendingConversationId: string | null = null;
let promptConversationId: string | null = null;
let browserOnline = navigator.onLine !== false;
let forgetting = false;
let profileClearing = false;

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
    purgeIdentityBoundState();
    render();
  },
  authorizationInvalidated: () => {
    purgeAuthorizationBoundState();
    render();
  },
  forgetting: (value) => {
    forgetting = value;
    render();
  },
  profileClearing: (value) => {
    profileClearing = value;
    render();
  },
  pairingCode: (code) => {
    pairingCode = code;
    pairing = true;
    render();
  },
  shell: (value) => {
    shell = value;
    shellCheckedAt = value.generatedAt;
    render();
  },
  detail: (value) => {
    detail = value;
    detailCheckedAt = value?.generatedAt ?? null;
    if (value === null) purgeAuthoritativeDetail();
    if (value === null && !promptStatus?.uncertain) promptStatus = null;
    render();
  },
  freshness: ({ checkedAt, resource }) => {
    if (resource.kind === "state" && shell) shellCheckedAt = checkedAt;
    if (
      resource.kind === "conversation"
      && detail?.conversation.id === resource.conversationId
    ) detailCheckedAt = checkedAt;
    renderUpdatedLine();
  },
  promptResult: (message, uncertain, conversationId) => {
    if (conversationId && conversationId !== promptConversationId) return;
    promptStatus = { message, uncertain };
    render();
  },
});

const renderConnectivity = (): void => {
  browserOnline = navigator.onLine !== false;
  render();
};
window.addEventListener("online", renderConnectivity);
window.addEventListener("offline", renderConnectivity);

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
  renderUpdatedLine();

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
  profileView.reconnect.disabled = forgetting || !browserOnline
    || connection?.phase === "connecting";
  profileView.reconnect.textContent = connection?.phase === "terminal"
    ? "Retry connection"
    : connection?.phase === "connecting"
      ? "Connecting…"
      : "Reconnect";
  profileView.forget.disabled = forgetting;
  profileView.forget.textContent = forgetting
    ? "Forgetting…"
    : "Forget this browser";

  empty.hidden = shell !== null;
  layout.hidden = shell === null;
  if (!shell) return;
  renderNavigation(shell);
  renderDetail(detail, profile.scopes.includes("prompt"));
}

function renderUpdatedLine(): void {
  const lastUpdated = detail ? detailCheckedAt : shell ? shellCheckedAt : null;
  updatedLine.textContent = lastUpdated
    ? `${online ? "Last updated" : "Cached · last updated"} ${new Date(lastUpdated).toLocaleString()}`
    : "";
  updatedLine.hidden = lastUpdated === null;
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
    "Keep the desktop nearby. Pairing is supervised: compare the six-digit code, choose exact conversation grants on the desktop, then approve there.",
    "muted",
  );
  const linkStatus = appendRemoteText(section, pairingLinkMessage, "status");
  linkStatus.setAttribute("role", "status");
  linkStatus.hidden = pairingLinkMessage.length === 0;
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Browser name";
  const name = document.createElement("input");
  name.id = "remote-device-name";
  name.maxLength = 80;
  name.value = navigator.userAgent.includes("Mobile")
    ? "Mobile browser"
    : "Web browser";
  nameLabel.append(name);
  const advanced = document.createElement("details");
  advanced.className = "pairing-advanced";
  advanced.open = initialInvitationText.length === 0;
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "Advanced: paste invitation JSON";
  const invitationLabel = document.createElement("label");
  invitationLabel.textContent = "Raw invitation JSON";
  const invitation = document.createElement("textarea");
  invitation.id = "remote-invitation-input";
  invitation.setAttribute("aria-label", "Invitation");
  invitation.rows = 8;
  invitation.spellcheck = false;
  invitation.autocomplete = "off";
  invitation.value = initialInvitationText;
  invitationLabel.append(invitation);
  advanced.append(advancedSummary, invitationLabel);
  const submit = button("Pair", () => {
    if (pairing || !browserOnline) return;
    pairing = true;
    render();
    void client.pair(invitation.value, name.value).then(() => {
      invitation.value = "";
      initialInvitationText = "";
      pairingLinkMessage = "";
      linkStatus.textContent = "";
      linkStatus.hidden = true;
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
  section.append(nameLabel, advanced, submit);
  return { root: section, name, invitation, submit, code };
}

function renderPairing(): void {
  pairingView.submit.disabled = profileClearing
    || forgetting
    || pairing
    || !browserOnline;
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
  forget: HTMLButtonElement;
} {
  const section = document.createElement("section");
  section.className = "card";
  const heading = document.createElement("h2");
  const permissions = appendRemoteText(section, "", "muted");
  const reconnect = button("Reconnect", () => void client.connect());
  const forget = button("Forget this browser", () => {
    void client.forget().catch(() => undefined);
  }, "secondary");
  section.prepend(heading);
  section.append(reconnect, forget);
  return { root: section, heading, permissions, reconnect, forget };
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
    const operation = ++sendOperation;
    sending = true;
    sendingConversationId = target;
    promptStatus = null;
    render();
    void client.sendPrompt(target, content).then((accepted) => {
      if (accepted && promptConversationId === target) prompt.value = "";
    }, () => {
      if (promptConversationId === target) {
        promptStatus = {
          message: "Delivery is uncertain. The prompt was not retried.",
          uncertain: true,
        };
      }
    }).finally(() => {
      if (sendOperation !== operation) return;
      sending = false;
      sendingConversationId = null;
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
  let projectCursor = navigation.firstChild;
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
    let conversationCursor = view.heading.nextSibling;
    for (const item of items) {
      let node = view.conversations.get(item.id);
      if (!node) {
        node = button("", () => client.selectConversation(item.id));
        node.dataset.remoteKey = `conversation:${item.id}`;
        view.conversations.set(item.id, node);
      }
      node.textContent = `${item.title} · ${item.status}`;
      node.className = detail?.conversation.id === item.id ? "selected" : "";
      if (node !== conversationCursor) {
        view.root.insertBefore(node, conversationCursor);
      }
      conversationCursor = node.nextSibling;
    }
    if (view.root !== projectCursor) {
      navigation.insertBefore(view.root, projectCursor);
    }
    projectCursor = view.root.nextSibling;
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
      ? sendingConversationId === value.conversation.id
        ? "Sending…"
        : "Another prompt is sending…"
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

function purgeAuthoritativeDetail(): void {
  detail = null;
  detailCheckedAt = null;
  promptConversationId = null;
  promptStatus = null;
  for (const view of messageViews.values()) view.root.remove();
  messageViews.clear();
  for (const node of activityViews.values()) node.remove();
  activityViews.clear();
  for (const node of subagentViews.values()) node.remove();
  subagentViews.clear();
  conversation.transcript.replaceChildren();
  conversation.activityList.replaceChildren();
  conversation.subagentList.replaceChildren();
  conversation.heading.textContent = "";
  conversation.meta.textContent = "";
  conversation.waiting.textContent = "";
  conversation.activitySummary.textContent = "";
  conversation.subagentSummary.textContent = "";
  conversation.promptInfo.textContent = "";
  conversation.safety.textContent = "";
  conversation.prompt.value = "";
  conversation.result.textContent = "";
}

function purgeIdentityBoundState(): void {
  purgeAuthorizationBoundState();
  profileView.heading.textContent = "";
  profileView.permissions.textContent = "";
}

function purgeAuthorizationBoundState(): void {
  shell = null;
  shellCheckedAt = null;
  purgeAuthoritativeDetail();
  for (const view of projectViews.values()) {
    view.root.remove();
    view.conversations.clear();
  }
  projectViews.clear();
  navigation.replaceChildren();
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
  let cursor = conversation.transcript.firstChild;
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
    const role = message.role === "user" ? "You" : "Agent";
    if (view.role.textContent !== role) view.role.textContent = role;
    if (view.content.textContent !== message.content) {
      view.content.textContent = message.content;
    }
    if (view.root !== cursor) {
      conversation.transcript.insertBefore(view.root, cursor);
    }
    cursor = view.root.nextSibling;
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
  let cursor = parent.firstChild;
  for (const value of values) {
    const id = key(value);
    let node = views.get(id);
    if (!node) {
      node = document.createElement("div");
      node.className = "activity";
      node.dataset.remoteKey = id;
      views.set(id, node);
    }
    const nextText = text(value);
    if (node.textContent !== nextText) node.textContent = nextText;
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
}
