import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, X } from "lucide-react";
import {
  defaultSettings,
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AppSettings,
  type ChatAttachment,
  type ClientCommand,
  type Conversation,
  type GitBranchInfo,
  type GitDiffSnapshot,
  type GitStatusSnapshot,
  type Project,
  type ProjectAction,
  type ProviderId,
  type ServerEvent,
  type ThemePreference,
  type ThreadUsageSnapshot,
  type WorkspaceEntry,
  type WorkspaceFilePreview,
} from "@shared/contracts";
import type { PreviewBounds, PreviewState } from "@shared/desktop";
import { ChangesPanel } from "./components/ChangesPanel";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { CommandPalette } from "./components/CommandPalette";
import { CommitDialog } from "./components/CommitDialog";
import { FilesPanel } from "./components/FilesPanel";
import { PaneResizeHandle } from "./components/PaneResizeHandle";
import { PlanPanel, type PlanStep } from "./components/PlanPanel";
import { PreviewPanel } from "./components/PreviewPanel";
import { ProviderAuthDialog } from "./components/ProviderAuthDialog";
import { SettingsView } from "./components/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { WorkspaceHeader } from "./components/WorkspaceHeader";
import { WorkspacePanel, type WorkspacePanelTab } from "./components/WorkspacePanel";
import { IconButton } from "./components/ui";
import { useInertiaConnection } from "./hooks/useInertiaConnection";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePersistedSize } from "./hooks/usePersistedSize";
import { useTheme } from "./hooks/useTheme";
import { projectNameFromPath } from "./lib/format";

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

type ResultEvent = Extract<ServerEvent, { type: "request.result" }>;

function withRequestId(command: CommandWithoutId): ClientCommand {
  return { ...command, requestId: crypto.randomUUID() } as ClientCommand;
}

function resultEvent(event: ServerEvent): ResultEvent {
  if (event.type !== "request.result") throw new Error("The local service returned an unexpected response.");
  return event;
}

const themeOrder: ThemePreference[] = ["system", "light", "dark"];
const RESIZE_HANDLE_SIZE = 7;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const CHAT_MIN_WIDTH = 340;
const CHAT_MIN_HEIGHT = 220;
const TOOLS_MIN_WIDTH = 300;
const TOOLS_MAX_WIDTH = 960;
const TOOLS_MIN_HEIGHT = 180;
const TOOLS_MAX_HEIGHT = 720;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function planFromText(text: string, status: Conversation["status"]): PlanStep[] {
  const lines = text.split("\n");
  const candidates: PlanStep[] = lines.flatMap((line, index) => {
    const match = /^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.{3,200})$/u.exec(line);
    if (!match) return [];
    return [{ id: `step-${index}`, title: match[1].replace(/\*\*/g, "").trim(), status: "pending" as const }];
  }).slice(0, 20);
  if (status === "running" && candidates[0]) candidates[0] = { ...candidates[0], status: "in-progress" };
  if (status === "completed") return candidates.map((step) => ({ ...step, status: "completed" as const }));
  return candidates;
}

export default function App(): React.JSX.Element {
  const connection = useInertiaConnection();
  const [view, setView] = useState<"workspace" | "settings">("workspace");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem("inertia:layout:sidebar-collapsed:v1") === "true");
  const [activeTool, setActiveTool] = useState<WorkspacePanelTab | null>(() => {
    const saved = window.localStorage.getItem("inertia:layout:active-tool:v1");
    return saved === "collapsed" ? null : saved === "changes" || saved === "files" || saved === "terminal" || saved === "plan" || saved === "preview" ? saved : "terminal";
  });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffSnapshot | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [workspaceEntries, setWorkspaceEntries] = useState<WorkspaceEntry[]>([]);
  const [mentionResults, setMentionResults] = useState<WorkspaceEntry[]>([]);
  const [entriesTruncated, setEntriesTruncated] = useState(false);
  const [filePreview, setFilePreview] = useState<WorkspaceFilePreview | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [projectActions, setProjectActions] = useState<ProjectAction[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [liveUsage, setLiveUsage] = useState<Record<string, ThreadUsageSnapshot>>({});
  const [pendingApprovals, setPendingApprovals] = useState<AgentApprovalRequest[]>([]);
  const [pendingInputs, setPendingInputs] = useState<AgentInputRequest[]>([]);
  const [nativePlans, setNativePlans] = useState<Record<string, AgentPlan>>({});
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewNavigation, setPreviewNavigation] = useState<PreviewState>({ url: "", loading: false, canGoBack: false, canGoForward: false });
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [authProviderId, setAuthProviderId] = useState<ProviderId | null>(null);
  const [persistedSidebarWidth, setPersistedSidebarWidth] = usePersistedSize("inertia:layout:sidebar-width:v1", 276, { min: SIDEBAR_MIN_WIDTH, max: SIDEBAR_MAX_WIDTH });
  const [persistedToolsWidth, setPersistedToolsWidth] = usePersistedSize("inertia:layout:workspace-tools-width:v1", 520, { min: TOOLS_MIN_WIDTH, max: TOOLS_MAX_WIDTH });
  const [persistedToolsHeight, setPersistedToolsHeight] = usePersistedSize("inertia:layout:workspace-tools-height:v1", 320, { min: TOOLS_MIN_HEIGHT, max: TOOLS_MAX_HEIGHT });
  const [sidebarWidth, setSidebarWidth] = useState(persistedSidebarWidth);
  const [toolsWidth, setToolsWidth] = useState(persistedToolsWidth);
  const [toolsHeight, setToolsHeight] = useState(persistedToolsHeight);
  const [shellWidth, setShellWidth] = useState(() => window.innerWidth);
  const [workspaceBodySize, setWorkspaceBodySize] = useState(() => ({ width: Math.max(0, window.innerWidth - 300), height: Math.max(0, window.innerHeight - 80) }));
  const stackedTools = useMediaQuery("(max-width: 1024px)");
  const mobileNavigation = useMediaQuery("(max-width: 760px)");
  const searchTimer = useRef<number | null>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const workspaceBodyRef = useRef<HTMLDivElement>(null);
  const settings = connection.snapshot?.settings ?? defaultSettings;
  useTheme(settings.theme);

  useEffect(() => {
    if (!connection.snapshot) return;
    setNativePlans(Object.fromEntries(connection.snapshot.plans.map((plan) => [plan.conversationId, plan])));
  }, [connection.snapshot?.plans]);

  useEffect(() => setSidebarWidth(persistedSidebarWidth), [persistedSidebarWidth]);
  useEffect(() => setToolsWidth(persistedToolsWidth), [persistedToolsWidth]);
  useEffect(() => setToolsHeight(persistedToolsHeight), [persistedToolsHeight]);
  useEffect(() => window.localStorage.setItem("inertia:layout:sidebar-collapsed:v1", String(sidebarCollapsed)), [sidebarCollapsed]);
  useEffect(() => window.localStorage.setItem("inertia:layout:active-tool:v1", activeTool ?? "collapsed"), [activeTool]);

  useEffect(() => {
    const shell = appShellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(([entry]) => setShellWidth(entry.contentRect.width));
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const body = workspaceBodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceBodySize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const project = useMemo(
    () => connection.snapshot?.projects.find((item) => item.id === connection.snapshot?.activeProjectId) ?? null,
    [connection.snapshot],
  );
  const conversation = useMemo(
    () => connection.snapshot?.conversations.find((item) => item.id === connection.snapshot?.activeConversationId) ?? null,
    [connection.snapshot],
  );
  const messages = useMemo(
    () => connection.snapshot?.messages.filter((message) => message.conversationId === conversation?.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) ?? [],
    [connection.snapshot, conversation?.id],
  );
  const activities = useMemo(
    () => connection.snapshot?.activities.filter((activity) => activity.conversationId === conversation?.id).slice(-30) ?? [],
    [connection.snapshot, conversation?.id],
  );
  const reasonings = useMemo(
    () => connection.snapshot?.reasonings.filter((reasoning) => reasoning.conversationId === conversation?.id) ?? [],
    [connection.snapshot, conversation?.id],
  );
  const usage = useMemo(() => {
    if (!conversation) return null;
    return liveUsage[conversation.id]
      ?? connection.snapshot?.usage.find((item) => item.conversationId === conversation.id)
      ?? null;
  }, [connection.snapshot?.usage, conversation, liveUsage]);
  const checkpoints = useMemo(
    () => connection.snapshot?.checkpoints.filter((checkpoint) => checkpoint.conversationId === conversation?.id) ?? [],
    [connection.snapshot, conversation?.id],
  );
  const authProvider = useMemo(
    () => connection.snapshot?.providers.find(({ id }) => id === authProviderId) ?? null,
    [authProviderId, connection.snapshot?.providers],
  );
  const planSteps = useMemo(() => {
    const nativePlan = conversation ? nativePlans[conversation.id] : undefined;
    if (nativePlan) {
      return nativePlan.steps.map((step, index) => ({
        id: `native-${index}`,
        title: step.step,
        status: step.status === "inProgress" ? "in-progress" as const : step.status,
      }));
    }
    const text = [...messages].reverse().find((message) => message.role === "assistant")?.content ?? streamingText;
    return planFromText(text, conversation?.status ?? "idle");
  }, [conversation, messages, nativePlans, streamingText]);

  const run = useCallback(async (key: string, command: CommandWithoutId): Promise<ServerEvent> => {
    setBusyAction(key);
    setActionError(null);
    try {
      return await connection.sendCommand(withRequestId(command));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That action could not be completed.");
      throw error;
    } finally {
      setBusyAction((current) => current === key ? null : current);
    }
  }, [connection.sendCommand]);

  const request = useCallback((command: CommandWithoutId) => connection.sendCommand(withRequestId(command)), [connection.sendCommand]);

  useEffect(() => connection.subscribe((event) => {
    if (event.type === "agent.approval.requested") {
      setPendingApprovals((current) => [...current.filter(({ id }) => id !== event.request.id), event.request]);
      return;
    }
    if (event.type === "agent.approval.resolved") {
      setPendingApprovals((current) => current.filter(({ id }) => id !== event.requestId));
      return;
    }
    if (event.type === "agent.input.requested") {
      setPendingInputs((current) => [...current.filter(({ id }) => id !== event.request.id), event.request]);
      return;
    }
    if (event.type === "agent.input.resolved") {
      setPendingInputs((current) => current.filter(({ id }) => id !== event.requestId));
      return;
    }
    if (event.type === "agent.plan.updated") {
      setNativePlans((current) => ({ ...current, [event.plan.conversationId]: event.plan }));
      if (settings.autoOpenPlan && event.plan.conversationId === conversation?.id) setActiveTool("plan");
      return;
    }
    if (event.type === "agent.usage") {
      setLiveUsage((current) => ({ ...current, [event.usage.conversationId]: event.usage }));
      return;
    }
    if (!conversation || !("conversationId" in event) || event.conversationId !== conversation.id) return;
    if (event.type === "agent.started") { setStreamingText(""); setStreamingReasoning(""); }
    if (event.type === "agent.text") setStreamingText((current) => `${current}${event.text}`.slice(-500_000));
    if (event.type === "agent.reasoning") setStreamingReasoning((current) => `${current}${event.text}`.slice(-500_000));
    if (event.type === "agent.completed" || event.type === "agent.failed") { setStreamingText(""); setStreamingReasoning(""); }
  }), [connection.subscribe, conversation, settings.autoOpenPlan]);

  useEffect(() => {
    setStreamingText("");
    setStreamingReasoning("");
  }, [conversation?.id]);

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setPaletteOpen(true); }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); createConversation(); }
      if (event.key.toLowerCase() === "j") { event.preventDefault(); setActiveTool((tool) => tool === "terminal" ? null : "terminal"); }
      if (event.key.toLowerCase() === "b") { event.preventDefault(); if (mobileNavigation) setSidebarOpen(true); else setSidebarCollapsed((collapsed) => !collapsed); }
    };
    // Capture app-wide shortcuts before focused widgets such as xterm can
    // consume platform combinations like Ctrl+K.
    window.addEventListener("keydown", shortcuts, true);
    return () => window.removeEventListener("keydown", shortcuts, true);
  });

  const loadGit = useCallback(async () => {
    if (!project) return;
    const event = resultEvent(await request({ type: "git.refresh", payload: { projectId: project.id, conversationId: conversation?.id } }));
    if (event.result.kind !== "git.status") throw new Error("Unexpected Git response.");
    setGitStatus(event.result.status);
    if (!event.result.status.isRepository) { setGitDiff(null); setBranches([]); return; }
    const diffEvent = resultEvent(await request({ type: "git.diff", payload: { projectId: project.id, conversationId: conversation?.id, ignoreWhitespace: settings.ignoreWhitespace } }));
    if (diffEvent.result.kind === "git.diff") {
      const nextDiff = diffEvent.result.diff;
      setGitDiff(nextDiff);
      setSelectedChange((current) => current && nextDiff.files.some(({ path }) => path === current) ? current : nextDiff.files[0]?.path ?? null);
    }
  }, [conversation?.id, project, request, settings.ignoreWhitespace]);

  const loadFiles = useCallback(async (query?: string) => {
    if (!project) return;
    const event = resultEvent(await request({ type: "workspace.entries", payload: { projectId: project.id, conversationId: conversation?.id, ...(query?.trim() ? { query: query.trim() } : {}) } }));
    if (event.result.kind !== "workspace.entries") throw new Error("Unexpected file response.");
    setWorkspaceEntries(event.result.entries);
    setEntriesTruncated(event.result.truncated);
  }, [conversation?.id, project, request]);

  const loadActions = useCallback(async () => {
    if (!project) return;
    try {
      const event = resultEvent(await request({ type: "project.actions", payload: { projectId: project.id, conversationId: conversation?.id } }));
      if (event.result.kind === "project.actions") setProjectActions(event.result.actions);
    } catch { setProjectActions([]); }
  }, [conversation?.id, project, request]);

  useEffect(() => {
    setGitStatus(null); setGitDiff(null); setWorkspaceEntries([]); setFilePreview(null); setSelectedFile(null); setSelectedChange(null); setProjectActions([]);
    if (!project || connection.status !== "online") return;
    let cancelled = false;
    setToolsLoading(true);
    void Promise.allSettled([loadGit(), loadFiles(), loadActions()]).then((results) => {
      if (cancelled) return;
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") setActionError(failed.reason instanceof Error ? failed.reason.message : "Some workspace tools could not be loaded.");
      setToolsLoading(false);
    });
    return () => { cancelled = true; };
  }, [connection.status, conversation?.id, loadActions, loadFiles, loadGit, project]);

  const importProject = async () => {
    if (busyAction) return;
    try {
      const path = await window.inertia.selectDirectory();
      if (!path) return;
      await run("project.create", { type: "project.create", payload: { name: projectNameFromPath(path), path } });
      setView("workspace"); setSidebarOpen(false); setActiveTool("terminal");
    } catch { /* The toast carries the error. */ }
  };

  const selectProject = (nextProject: Project) => {
    if (nextProject.id === project?.id) return;
    void run("project.select", { type: "project.select", payload: { projectId: nextProject.id } }).catch(() => undefined);
  };
  const selectConversation = (nextConversation: Conversation) => {
    if (nextConversation.id === conversation?.id) return;
    void run("conversation.select", { type: "conversation.select", payload: { conversationId: nextConversation.id } }).catch(() => undefined);
  };
  const createConversation = (targetProject: Project | null = project) => {
    if (!targetProject) return;
    const select = targetProject.id === project?.id ? Promise.resolve() : run("project.select", { type: "project.select", payload: { projectId: targetProject.id } });
    void select.then(() => run("conversation.create", { type: "conversation.create", payload: { projectId: targetProject.id, title: "New thread", providerId: settings.defaultProvider, model: settings.defaultModel, reasoningEffort: settings.defaultReasoningEffort, interactionMode: settings.defaultInteractionMode, accessMode: settings.defaultAccessMode, useWorktree: settings.newThreadMode === "worktree" } })).then(() => { setView("workspace"); setSidebarOpen(false); }).catch(() => undefined);
  };
  const sendMessage = async (content: string, attachments: ChatAttachment[]) => {
    if (!conversation) return;
    await run("message.send", { type: "message.send", payload: { conversationId: conversation.id, content, attachments } });
  };
  const respondToApproval = async (request: AgentApprovalRequest, decision: AgentApprovalDecision) => {
    await run("agent.approval.respond", {
      type: "agent.approval.respond",
      payload: { conversationId: request.conversationId, requestId: request.id, decision },
    });
  };
  const respondToInput = async (request: AgentInputRequest, answers: Record<string, string[]>) => {
    await run("agent.input.respond", {
      type: "agent.input.respond",
      payload: { conversationId: request.conversationId, requestId: request.id, answers },
    });
  };
  const updateConversation = (update: Partial<Pick<Conversation, "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => {
    if (!conversation) return;
    void run("conversation.update", { type: "conversation.update", payload: { conversationId: conversation.id, ...update } }).catch(() => undefined);
  };
  const updateSettings = (updates: Partial<AppSettings>) => { void run("settings.update", { type: "settings.update", payload: updates }).catch(() => undefined); };
  const cycleTheme = () => updateSettings({ theme: themeOrder[(themeOrder.indexOf(settings.theme) + 1) % themeOrder.length] });
  const refreshProvider = useCallback((providerId?: ProviderId) => {
    void run("provider.refresh", { type: "provider.refresh", payload: { ...(providerId ? { providerId } : {}) } }).catch(() => undefined);
  }, [run]);
  const connectProvider = useCallback((providerId: ProviderId) => setAuthProviderId(providerId), []);
  const closeProviderAuth = useCallback(() => setAuthProviderId(null), []);

  const loadBranches = () => {
    if (!project || !gitStatus?.isRepository) return;
    void request({ type: "git.branches", payload: { projectId: project.id } }).then(resultEvent).then((event) => { if (event.result.kind === "git.branches") setBranches(event.result.branches); }).catch((error) => setActionError(error instanceof Error ? error.message : "Branches could not be loaded."));
  };
  const mutateBranch = (type: "git.branch.create" | "git.branch.switch", name: string) => {
    if (!project) return;
    void run(type, { type, payload: { projectId: project.id, name } } as CommandWithoutId).then(() => Promise.all([loadGit(), Promise.resolve(loadBranches())])).catch(() => undefined);
  };
  const commit = async (message: string, push: boolean) => {
    if (!project) return;
    await run("git.commit", { type: "git.commit", payload: { projectId: project.id, conversationId: conversation?.id, message } });
    if (push) await run("git.push", { type: "git.push", payload: { projectId: project.id, conversationId: conversation?.id } });
    setCommitDialogOpen(false); await loadGit();
  };
  const selectChangedFile = (path: string) => {
    if (!project) return;
    setSelectedChange(path); setToolsLoading(true);
    void request({ type: "git.diff", payload: { projectId: project.id, conversationId: conversation?.id, path, ignoreWhitespace: settings.ignoreWhitespace } }).then(resultEvent).then((event) => { if (event.result.kind === "git.diff") setGitDiff(event.result.diff); }).catch((error) => setActionError(error instanceof Error ? error.message : "The diff could not be loaded.")).finally(() => setToolsLoading(false));
  };
  const selectWorkspaceFile = (path: string) => {
    if (!project) return;
    setSelectedFile(path); setFilePreview(null); setToolsLoading(true);
    void request({ type: "workspace.file.read", payload: { projectId: project.id, conversationId: conversation?.id, path } }).then(resultEvent).then((event) => { if (event.result.kind === "workspace.file") setFilePreview(event.result.file); }).catch((error) => setActionError(error instanceof Error ? error.message : "The file could not be opened.")).finally(() => setToolsLoading(false));
  };
  const searchFiles = (query: string) => {
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => { void loadFiles(query).catch((error) => setActionError(error instanceof Error ? error.message : "File search failed.")); }, 220);
  };
  const searchMentions = useCallback((query: string) => {
    if (!project || !query.trim()) { setMentionResults([]); return; }
    void request({ type: "workspace.entries", payload: { projectId: project.id, conversationId: conversation?.id, query: query.trim() } })
      .then(resultEvent)
      .then((event) => { if (event.result.kind === "workspace.entries") setMentionResults(event.result.entries.slice(0, 8)); })
      .catch(() => setMentionResults([]));
  }, [conversation?.id, project, request]);
  const runProjectAction = (action: ProjectAction) => { setPendingActionId(action.id); setActiveTool("terminal"); };
  const chooseComposerAttachments = async (): Promise<ChatAttachment[]> => {
    try { return await window.inertia.selectAttachments(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Images could not be attached."); return []; }
  };
  const importComposerAttachments = async (files: File[]): Promise<ChatAttachment[]> => {
    try {
      return await window.inertia.importAttachments(await Promise.all(files.map(async (file) => ({ name: file.name, mimeType: file.type as "image/png" | "image/jpeg" | "image/webp" | "image/gif", data: await file.arrayBuffer() }))));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Images could not be attached.");
      return [];
    }
  };
  const navigatePreview = useCallback((url: string) => {
    setPreviewUrl(url);
    setPreviewNavigation((current) => ({ ...current, url, loading: true }));
    void window.inertia.previewNavigate(url).then(setPreviewNavigation).catch((error) => { setActionError(error instanceof Error ? error.message : "The preview could not be opened."); setPreviewNavigation((current) => ({ ...current, loading: false })); });
  }, []);
  const previewCommand = useCallback((action: "back" | "forward" | "reload") => {
    void window.inertia.previewCommand(action).then((state) => { setPreviewNavigation(state); if (state.url) setPreviewUrl(state.url); }).catch((error) => setActionError(error instanceof Error ? error.message : "The preview command failed."));
  }, []);
  const setPreviewBounds = useCallback((bounds: PreviewBounds | null) => { void window.inertia.previewSetBounds(bounds).catch(() => undefined); }, []);

  const visibleError = actionError ?? connection.error;
  const platform = window.inertia?.getPlatform() ?? "unknown";
  const toolsVisible = view === "workspace" && Boolean(activeTool && project);
  const minimumWorkspaceWidth = !stackedTools && toolsVisible
    ? CHAT_MIN_WIDTH + TOOLS_MIN_WIDTH + RESIZE_HANDLE_SIZE + 18
    : 440;
  const sidebarDynamicMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(SIDEBAR_MAX_WIDTH, shellWidth - minimumWorkspaceWidth - RESIZE_HANDLE_SIZE),
  );
  const toolsDynamicMaxWidth = Math.max(
    TOOLS_MIN_WIDTH,
    Math.min(TOOLS_MAX_WIDTH, workspaceBodySize.width - CHAT_MIN_WIDTH - RESIZE_HANDLE_SIZE),
  );
  const toolsDynamicMaxHeight = Math.max(
    TOOLS_MIN_HEIGHT,
    Math.min(TOOLS_MAX_HEIGHT, workspaceBodySize.height - CHAT_MIN_HEIGHT - RESIZE_HANDLE_SIZE),
  );
  const effectiveSidebarWidth = !mobileNavigation && sidebarCollapsed ? 0 : clamp(sidebarWidth, SIDEBAR_MIN_WIDTH, sidebarDynamicMax);
  const effectiveToolsWidth = clamp(toolsWidth, TOOLS_MIN_WIDTH, toolsDynamicMaxWidth);
  const effectiveToolsHeight = clamp(toolsHeight, TOOLS_MIN_HEIGHT, toolsDynamicMaxHeight);
  const appShellStyle = { "--sidebar-width": `${effectiveSidebarWidth}px` } as CSSProperties;
  const workspaceBodyStyle = {
    "--workspace-tools-width": `${effectiveToolsWidth}px`,
    "--workspace-tools-height": `${effectiveToolsHeight}px`,
  } as CSSProperties;

  return (
    <div ref={appShellRef} className={`app-shell platform-${platform}${sidebarCollapsed && !mobileNavigation ? " is-sidebar-collapsed" : ""}`} style={appShellStyle}>
      {(mobileNavigation || !sidebarCollapsed) && <Sidebar
        snapshot={connection.snapshot} connectionStatus={connection.status} view={view} open={sidebarOpen} busy={busyAction === "project.create"}
        onClose={() => setSidebarOpen(false)} onViewChange={setView} onImportProject={() => void importProject()} onSelectProject={selectProject} onSelectConversation={selectConversation} onCreateConversation={createConversation}
        onRenameConversation={(thread, title) => { void run("conversation.update", { type: "conversation.update", payload: { conversationId: thread.id, title } }).catch(() => undefined); }}
        onArchiveConversation={(thread) => { void run("conversation.archive", { type: "conversation.archive", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onDeleteConversation={(thread) => { if (!settings.confirmDestructiveActions || window.confirm(`Delete “${thread.title}”? This cannot be undone.`)) void run("conversation.delete", { type: "conversation.delete", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onRemoveProject={(item) => { if (!settings.confirmDestructiveActions || window.confirm(`Remove “${item.name}” from Inertia? Files on disk will not be deleted.`)) void run("project.remove", { type: "project.remove", payload: { projectId: item.id } }).catch(() => undefined); }}
      />}

      {!mobileNavigation && !sidebarCollapsed && (
        <PaneResizeHandle
          label="Resize project navigation"
          controls="main-workspace"
          containerRef={appShellRef}
          orientation="vertical"
          value={effectiveSidebarWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={sidebarDynamicMax}
          defaultValue={276}
          onChange={setSidebarWidth}
          onCommit={setPersistedSidebarWidth}
          valueText={(value) => `${value} pixels for project navigation`}
          className="sidebar-resize-handle"
        />
      )}

      <section className="workspace-shell" id="main-workspace">
        <div className="workspace-frame">
          <WorkspaceHeader
            project={project} conversation={conversation} view={view} activeTool={activeTool} sidebarCollapsed={sidebarCollapsed} theme={settings.theme} gitStatus={gitStatus} branches={branches} actions={projectActions} busy={Boolean(busyAction)}
            onOpenSidebar={() => { if (mobileNavigation) setSidebarOpen(true); else setSidebarCollapsed((collapsed) => !collapsed); }} onToggleTools={() => setActiveTool((tool) => tool ? null : "terminal")} onCycleTheme={cycleTheme} onOpenSettings={() => setView("settings")}
            onOpenProject={() => { if (project) void window.inertia.openPath(project.path).then((error) => { if (error) setActionError(error); }); }} onRefreshBranches={loadBranches}
            onSwitchBranch={(name) => mutateBranch("git.branch.switch", name)} onCreateBranch={(name) => mutateBranch("git.branch.create", name)} onCommit={() => setCommitDialogOpen(true)} onRunAction={runProjectAction}
            onOpenPullRequest={() => { if (project) void run("git.pr.open", { type: "git.pr.open", payload: { projectId: project.id, conversationId: conversation?.id } }).then(resultEvent).then((event) => { if (event.result.kind === "external.url") return window.inertia.openExternal(event.result.url); }).catch(() => undefined); }}
            onPull={() => { if (project) void run("git.pull", { type: "git.pull", payload: { projectId: project.id, conversationId: conversation?.id } }).then(() => loadGit()).catch(() => undefined); }}
          />

          <div
            ref={workspaceBodyRef}
            id="workspace-content"
            className={toolsVisible ? "workspace-body has-tools" : "workspace-body"}
            style={workspaceBodyStyle}
          >
            {view === "settings" ? (
              <SettingsView
                settings={settings}
                disabled={connection.status !== "online"}
                providers={connection.snapshot?.providers ?? []}
                archived={connection.snapshot?.conversations.filter(({ archivedAt }) => archivedAt !== null) ?? []}
                onUpdate={updateSettings}
                onConnectProvider={connectProvider}
                onRefreshProvider={refreshProvider}
                onUnarchive={(thread) => { void run("conversation.unarchive", { type: "conversation.unarchive", payload: { conversationId: thread.id } }).catch(() => undefined); }}
              />
            ) : (
              <ChatWorkspace project={project} conversation={conversation} messages={messages} activities={activities} reasonings={reasonings} checkpoints={checkpoints} streamingText={streamingText} streamingReasoning={streamingReasoning} usage={usage} approvals={pendingApprovals.filter((request) => request.conversationId === conversation?.id)} inputRequests={pendingInputs.filter((request) => request.conversationId === conversation?.id)} providers={connection.snapshot?.providers ?? []} actions={projectActions} mentionResults={mentionResults} showTimestamps={settings.showTimestamps} showThinking={settings.showThinking} showUsage={settings.showUsage} loading={!connection.snapshot && connection.status !== "offline"} sending={busyAction === "message.send"} onAddProject={() => void importProject()} onCreateConversation={() => createConversation()} onSendMessage={sendMessage} onRespondToApproval={respondToApproval} onRespondToInput={respondToInput} onUpdateConversation={updateConversation} onChooseAttachments={chooseComposerAttachments} onImportAttachments={importComposerAttachments} onRunAction={runProjectAction} onMentionQuery={searchMentions} onConnectProvider={connectProvider} onRefreshProvider={refreshProvider} onRevertCheckpoint={(checkpoint) => { if (conversation && (!settings.confirmDestructiveActions || window.confirm("Restore the project to before this turn? Untracked files created later will be left in place."))) void run("checkpoint.revert", { type: "checkpoint.revert", payload: { conversationId: conversation.id, checkpointId: checkpoint.id } }).then(() => loadGit()).catch(() => undefined); }} onStop={() => { if (conversation) void run("agent.stop", { type: "agent.stop", payload: { conversationId: conversation.id } }).catch(() => undefined); }} />
            )}

            {toolsVisible && (
              <PaneResizeHandle
                label="Resize workspace tools"
                controls="workspace-content"
                containerRef={workspaceBodyRef}
                orientation={stackedTools ? "horizontal" : "vertical"}
                pane="after"
                value={stackedTools ? effectiveToolsHeight : effectiveToolsWidth}
                min={stackedTools ? TOOLS_MIN_HEIGHT : TOOLS_MIN_WIDTH}
                max={stackedTools ? toolsDynamicMaxHeight : toolsDynamicMaxWidth}
                defaultValue={stackedTools ? 320 : 520}
                onChange={stackedTools ? setToolsHeight : setToolsWidth}
                onCommit={stackedTools ? setPersistedToolsHeight : setPersistedToolsWidth}
                valueText={(value) => `${value} pixels for workspace tools`}
                className="workspace-tools-resize-handle"
              />
            )}
            {project && (
              <WorkspacePanel activeTab={activeTool ?? "terminal"} visible={toolsVisible} onTabChange={setActiveTool} badges={{ changes: gitStatus?.files.length ?? 0, plan: planSteps.length }} onClose={() => setActiveTool(null)}>
                {activeTool === "changes" && <ChangesPanel files={gitStatus?.files ?? []} diff={gitDiff} selectedPath={selectedChange} loading={toolsLoading} wrapLines={settings.wrapDiffs} onSelectFile={selectChangedFile} onRefresh={() => void loadGit().catch((error) => setActionError(error instanceof Error ? error.message : "Changes could not be refreshed."))} />}
                {activeTool === "files" && <FilesPanel entries={workspaceEntries} preview={filePreview} selectedPath={selectedFile} loading={toolsLoading} entriesTruncated={entriesTruncated} onSelectFile={selectWorkspaceFile} onRefresh={() => void loadFiles().catch((error) => setActionError(error instanceof Error ? error.message : "Files could not be refreshed."))} onSearchChange={searchFiles} onOpenFile={(path) => { const root = conversation?.worktreePath ?? project.path; void window.inertia.openPath(`${root.replace(/[\\/]$/u, "")}/${path}`).then((error) => { if (error) setActionError(error); }); }} />}
                <TerminalPanel key={`${project.id}:${conversation?.id ?? "project"}`} visible={toolsVisible && activeTool === "terminal"} projectId={project.id} conversationId={conversation?.id} projectName={project.name} status={connection.status} fontSize={settings.terminalFontSize} theme={settings.theme} sendCommand={connection.sendCommand} subscribe={connection.subscribe} actionId={pendingActionId} onActionStarted={() => setPendingActionId(null)} onClose={() => setActiveTool(null)} />
                {activeTool === "plan" && <PlanPanel steps={planSteps} summary={conversation && nativePlans[conversation.id]?.explanation ? nativePlans[conversation.id].explanation! : conversation?.interactionMode === "plan" ? "The latest agent response is reflected as a working plan." : "Switch the composer to Plan mode and ask the agent to propose an approach."} onRefine={conversation && conversation.status !== "running" && conversation.status !== "needs-input" ? () => { updateConversation({ interactionMode: "plan" }); void sendMessage("Refine the implementation plan with clearer steps, risks, and validation.", []).catch(() => undefined); } : undefined} onImplement={conversation && planSteps.length > 0 && conversation.status !== "running" && conversation.status !== "needs-input" ? () => { updateConversation({ interactionMode: "build" }); void sendMessage("Implement the plan above and validate the result.", []).catch(() => undefined); setActiveTool("changes"); } : undefined} />}
                {activeTool === "preview" && <PreviewPanel url={previewUrl} loading={previewNavigation.loading} canGoBack={previewNavigation.canGoBack} canGoForward={previewNavigation.canGoForward} onNavigate={navigatePreview} onBack={() => previewCommand("back")} onForward={() => previewCommand("forward")} onReload={() => previewCommand("reload")} onBoundsChange={setPreviewBounds} onOpenExternal={(url) => { void window.inertia.openExternal(url).catch((error) => setActionError(error instanceof Error ? error.message : "The URL could not be opened.")); }} />}
              </WorkspacePanel>
            )}
          </div>
        </div>
      </section>

      <CommitDialog open={commitDialogOpen} status={gitStatus} busy={busyAction === "git.commit" || busyAction === "git.push"} onClose={() => setCommitDialogOpen(false)} onCommit={commit} />
      <CommandPalette
        open={paletteOpen}
        projects={connection.snapshot?.projects ?? []}
        conversations={connection.snapshot?.conversations ?? []}
        onClose={() => setPaletteOpen(false)}
        onSelectProject={(item) => { selectProject(item); setView("workspace"); }}
        onSelectConversation={(item) => { selectConversation(item); setView("workspace"); }}
        onNewThread={() => createConversation()}
        onAddProject={() => void importProject()}
        onOpenSettings={() => setView("settings")}
      />
      <ProviderAuthDialog
        provider={authProvider}
        status={connection.status}
        theme={settings.theme}
        fontSize={settings.terminalFontSize}
        sendCommand={connection.sendCommand}
        subscribe={connection.subscribe}
        onClose={closeProviderAuth}
      />
      {visibleError && <div className="error-toast" role="alert"><AlertCircle size={17} /><span>{visibleError}</span><IconButton label="Dismiss error" onClick={() => { setActionError(null); connection.clearError(); }}><X size={15} /></IconButton></div>}
    </div>
  );
}
