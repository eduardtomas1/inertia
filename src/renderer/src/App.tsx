import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, X } from "lucide-react";
import {
  defaultSettings,
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentActivity,
  type AgentInputRequest,
  type AgentPlan,
  type AppSettings,
  type ChatAttachment,
  type ClientCommand,
  type Conversation,
  type ConversationDetailViewState,
  type DiffReviewNote,
  type DiffSelectionReviewAnswer,
  type DiffReviewState,
  type DiffReversalOperation,
  type GitBranchInfo,
  type GitDiffSnapshot,
  type GitStatusSnapshot,
  type ModelBackendProfileDetail,
  type ModelBackendProfileDraft,
  type ModelSelection,
  type Project,
  type ProjectAction,
  type ProviderId,
  type ServerEvent,
  type ThreadUsageSnapshot,
  type TurnGitDiffSnapshot,
  type TurnRequestContext,
  type WorkspaceEntry,
  type WorkspaceFilePreview,
  type WorkspaceRun,
} from "@shared/contracts";
import { parseUnifiedDiff } from "@shared/diff-review";
import type { PreviewBounds, PreviewState } from "@shared/desktop";
import { selectConversationWorkspaceRun } from "../../shared/attention";
import { ChangesPanel, type DiffSelection } from "./components/ChangesPanel";
import { ActivityCenter } from "./components/ActivityCenter";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { CommandPalette } from "./components/CommandPalette";
import { CommitDialog } from "./components/CommitDialog";
import { ConversationDetailState } from "./components/ConversationDetailState";
import { FilesPanel } from "./components/FilesPanel";
import { HistoricalDiffPanel } from "./components/HistoricalDiffPanel";
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
import { activityRunSummary } from "./utils/activityCenter";
import { shouldMarkWorkspaceRunSeen } from "./utils/attentionVisibility";
import { mergeConversationShell, resolveConversationDetail } from "./utils/conversationDetail";
import {
  buildNewConversationPayload,
  type NewConversationLocation,
  withNewConversationModelSelection,
} from "./lib/newConversation";
import { cacheThemePreference, cachedThemePreference, nextQuickTheme } from "./utils/theme";
import { projectNameFromPath } from "./lib/format";

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

type ResultEvent = Extract<ServerEvent, { type: "request.result" }>;
type BackendProfileCreatePayload = Extract<
  ClientCommand,
  { type: "backend.profile.create" }
>["payload"];
type BackendProfileUpdatePayload = Extract<
  ClientCommand,
  { type: "backend.profile.update" }
>["payload"]["update"];
type ConversationCreatePayload = Extract<
  ClientCommand,
  { type: "conversation.create" }
>["payload"];

function withRequestId(command: CommandWithoutId): ClientCommand {
  return { ...command, requestId: crypto.randomUUID() } as ClientCommand;
}

function resultEvent(event: ServerEvent): ResultEvent {
  if (event.type !== "request.result") throw new Error("The local service returned an unexpected response.");
  return event;
}

function mutableBackendRouting(
  routing: ModelBackendProfileDraft["routing"],
): BackendProfileCreatePayload["routing"] {
  return routing.mode === "simple"
    ? { ...routing }
    : {
        ...routing,
        tierModels: { ...routing.tierModels },
      };
}

function mutableBackendModels(
  models: ModelBackendProfileDraft["models"],
): BackendProfileCreatePayload["models"] {
  return models.map((model) => ({
    ...model,
    reasoningOptions: model.reasoningOptions.map((option) => ({ ...option })),
    capabilities: model.capabilities.map((capability) => ({ ...capability })),
  }));
}

function backendProfileCreatePayload(
  draft: ModelBackendProfileDraft,
): BackendProfileCreatePayload {
  return {
    ...draft,
    models: mutableBackendModels(draft.models),
    routing: mutableBackendRouting(draft.routing),
    capabilityHints: draft.capabilityHints.map((capability) => ({ ...capability })),
  };
}

function backendProfileUpdatePayload(
  update: Partial<ModelBackendProfileDraft> & { enabled?: boolean },
): BackendProfileUpdatePayload {
  return {
    ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
    ...(update.harnessId !== undefined ? { harnessId: update.harnessId } : {}),
    ...(update.protocol !== undefined ? { protocol: update.protocol } : {}),
    ...(update.authenticationMode !== undefined
      ? { authenticationMode: update.authenticationMode }
      : {}),
    ...(update.preset !== undefined ? { preset: update.preset } : {}),
    ...(update.baseUrl !== undefined ? { baseUrl: update.baseUrl } : {}),
    ...(update.allowInsecureLocalhost !== undefined
      ? { allowInsecureLocalhost: update.allowInsecureLocalhost }
      : {}),
    ...(update.models !== undefined
      ? { models: mutableBackendModels(update.models) }
      : {}),
    ...(update.routing !== undefined
      ? { routing: mutableBackendRouting(update.routing) }
      : {}),
    ...(update.capabilityHints !== undefined
      ? {
          capabilityHints: update.capabilityHints.map((capability) => ({
            ...capability,
          })),
        }
      : {}),
    ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
  };
}

function commandRefreshesConversationDetail(command: CommandWithoutId): boolean {
  return [
    "message.send",
    "agent.approval.respond",
    "agent.input.respond",
    "review.state.set",
    "review.note.create",
    "review.note.update",
    "review.note.delete",
    "review.summary.generate",
    "git.commit",
    "git.selection.revert",
    "git.selection.undo",
    "checkpoint.revert",
  ].includes(command.type);
}

const RESIZE_HANDLE_SIZE = 7;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const CHAT_MIN_WIDTH = 340;
const CHAT_MIN_HEIGHT = 320;
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
  const [historicalDiff, setHistoricalDiff] = useState<TurnGitDiffSnapshot | null>(null);
  const [historicalSelectedPath, setHistoricalSelectedPath] = useState<string | null>(null);
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
  const [liveActivities, setLiveActivities] = useState<Record<string, AgentActivity[]>>({});
  const [pendingApprovals, setPendingApprovals] = useState<AgentApprovalRequest[]>([]);
  const [pendingInputs, setPendingInputs] = useState<AgentInputRequest[]>([]);
  const [nativePlans, setNativePlans] = useState<Record<string, AgentPlan>>({});
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewNavigation, setPreviewNavigation] = useState<PreviewState>({ url: "", loading: false, canGoBack: false, canGoForward: false });
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [pendingActivityAction, setPendingActivityAction] = useState<WorkspaceRun | null>(null);
  const [authProviderId, setAuthProviderId] = useState<ProviderId | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityNow, setActivityNow] = useState(Date.now());
  const [latestContentVisible, setLatestContentVisible] = useState(false);
  const [attentionVisibilityVersion, setAttentionVisibilityVersion] = useState(0);
  const [pendingDiffContext, setPendingDiffContext] = useState<string | null>(null);
  const [lastDiffReversal, setLastDiffReversal] = useState<DiffReversalOperation | null>(null);
  const [selectionReviewAnswer, setSelectionReviewAnswer] =
    useState<DiffSelectionReviewAnswer | null>(null);
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const [conversationDetailState, setConversationDetailState] = useState<ConversationDetailViewState | null>(null);
  const [conversationDetailRefresh, setConversationDetailRefresh] = useState(0);
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
  const pendingSeenRunsRef = useRef(new Set<string>());
  const detailRequestGenerationRef = useRef(0);
  const snapshotRef = useRef(connection.snapshot);
  snapshotRef.current = connection.snapshot;
  const settings = connection.snapshot?.settings ?? {
    ...defaultSettings,
    theme: cachedThemePreference(window.localStorage) ?? defaultSettings.theme,
  };
  useTheme(settings.theme);

  useEffect(() => {
    const preference = connection.snapshot?.settings.theme;
    if (!preference) return;
    cacheThemePreference(window.localStorage, preference);
    void window.inertia.syncThemePreference(preference).catch(() => undefined);
  }, [connection.snapshot?.settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.interfaceScale = settings.interfaceScale;
  }, [settings.interfaceScale]);

  useEffect(() => {
    setActivityNow(Date.now());
    const runs = connection.snapshot?.runs ?? [];
    const hasUnfinishedRun = runs.some(({ status }) => status === "running" || status === "waiting");
    if (!hasUnfinishedRun) return;
    const interval = window.setInterval(
      () => setActivityNow(Date.now()),
      activityOpen && hasUnfinishedRun ? 1_000 : 60_000,
    );
    return () => window.clearInterval(interval);
  }, [activityOpen, connection.snapshot?.runs]);

  useEffect(() => {
    const refreshVisibility = () => setAttentionVisibilityVersion((version) => version + 1);
    document.addEventListener("visibilitychange", refreshVisibility);
    window.addEventListener("focus", refreshVisibility);
    window.addEventListener("blur", refreshVisibility);
    return () => {
      document.removeEventListener("visibilitychange", refreshVisibility);
      window.removeEventListener("focus", refreshVisibility);
      window.removeEventListener("blur", refreshVisibility);
    };
  }, []);

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
  const conversationDetail = useMemo(() => {
    if (
      conversationDetailState?.state !== "ready"
      || conversationDetailState.conversationId !== conversation?.id
    ) {
      return null;
    }
    return conversation
      ? mergeConversationShell(conversationDetailState.detail, conversation)
      : conversationDetailState.detail;
  }, [conversation, conversationDetailState]);
  const turns = useMemo(
    () => conversationDetail?.agentTurns ?? [],
    [conversationDetail?.agentTurns],
  );
  const messages = useMemo(
    () => [...(conversationDetail?.messages ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [conversationDetail?.messages],
  );
  const activities = useMemo(
    () => {
      if (!conversation) return [];
      const merged = new Map<string, AgentActivity>();
      for (const activity of conversationDetail?.activities ?? []) merged.set(activity.id, activity);
      for (const activity of liveActivities[conversation.id] ?? []) merged.set(activity.id, activity);
      return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    [conversation, conversationDetail?.activities, liveActivities],
  );
  const reasonings = useMemo(
    () => conversationDetail?.reasonings ?? [],
    [conversationDetail?.reasonings],
  );
  const usage = useMemo(() => {
    if (!conversation) return null;
    return liveUsage[conversation.id]
      ?? conversationDetail?.usage.find((item) => item.conversationId === conversation.id)
      ?? null;
  }, [conversation, conversationDetail?.usage, liveUsage]);
  const checkpoints = useMemo(
    () => conversationDetail?.checkpoints ?? [],
    [conversationDetail?.checkpoints],
  );
  const turnGitArtifacts = useMemo(
    () => conversationDetail?.turnGitArtifacts ?? [],
    [conversationDetail?.turnGitArtifacts],
  );
  const plans = useMemo(() => {
    if (!conversation) return [];
    const merged = new Map<string, AgentPlan>();
    for (const plan of conversationDetail?.plans ?? []) {
      merged.set(`${plan.runId}:${plan.turnId ?? "legacy"}`, plan);
    }
    const live = nativePlans[conversation.id];
    if (live) merged.set(`${live.runId}:${live.turnId ?? "legacy"}`, live);
    return [...merged.values()];
  }, [conversation, conversationDetail?.plans, nativePlans]);
  const authProvider = useMemo(
    () => connection.snapshot?.providers.find(({ id }) => id === authProviderId) ?? null,
    [authProviderId, connection.snapshot?.providers],
  );
  const structuredDiff = useMemo(() => parseUnifiedDiff(gitDiff?.patch ?? ""), [gitDiff?.patch]);
  useEffect(() => {
    setSelectionReviewAnswer((current) => (
      current
      && current.conversationId === conversation?.id
      && current.fingerprint === structuredDiff.fingerprint
        ? current
        : null
    ));
  }, [conversation?.id, structuredDiff.fingerprint]);
  const reviewSummary = useMemo(() => conversationDetail?.reviewSummaries.find((summary) => (
    summary.conversationId === conversation?.id && summary.fingerprint === structuredDiff.fingerprint
  )) ?? null, [conversationDetail?.reviewSummaries, conversation?.id, structuredDiff.fingerprint]);
  const reviewStates = useMemo(
    () => conversationDetail?.reviewStates ?? [],
    [conversationDetail?.reviewStates],
  );
  const reviewNotes = useMemo(
    () => conversationDetail?.reviewNotes ?? [],
    [conversationDetail?.reviewNotes],
  );
  const runsSummary = useMemo(
    () => activityRunSummary(connection.snapshot?.runs ?? [], activityNow),
    [activityNow, connection.snapshot?.runs],
  );
  const visibleConversationRun = useMemo(
    () => conversation
      ? selectConversationWorkspaceRun(conversation.id, connection.snapshot?.runs ?? [])
      : null,
    [connection.snapshot?.runs, conversation],
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
      const event = await connection.sendCommand(withRequestId(command));
      if (commandRefreshesConversationDetail(command)) {
        setConversationDetailRefresh((version) => version + 1);
      }
      return event;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That action could not be completed.");
      throw error;
    } finally {
      setBusyAction((current) => current === key ? null : current);
    }
  }, [connection.sendCommand]);

  const request = useCallback((command: CommandWithoutId) => connection.sendCommand(withRequestId(command)), [connection.sendCommand]);

  useEffect(() => {
    const conversationId = connection.snapshot?.activeConversationId ?? null;
    if (!conversationId) {
      detailRequestGenerationRef.current += 1;
      setConversationDetailState(null);
      return;
    }

    setConversationDetailState((current) => (
      current?.conversationId === conversationId && current.state === "ready"
        ? current
        : { conversationId, state: "loading" }
    ));
    if (connection.status !== "online") {
      detailRequestGenerationRef.current += 1;
      return;
    }

    const generation = detailRequestGenerationRef.current + 1;
    detailRequestGenerationRef.current = generation;
    void request({
      type: "conversation.detail.load",
      payload: { conversationId },
    }).then((event) => {
      if (generation !== detailRequestGenerationRef.current) return;
      if (event.type !== "request.result" || event.result.kind !== "conversation.detail") {
        throw new Error("The local service returned an unexpected chat detail response.");
      }
      const result = event.result;
      const shell = snapshotRef.current?.conversations.find(({ id }) => id === conversationId) ?? null;
      setConversationDetailState((current) =>
        resolveConversationDetail(current, conversationId, result, shell));
    }).catch((error) => {
      if (generation !== detailRequestGenerationRef.current) return;
      setConversationDetailState({
        kind: "conversation.detail",
        conversationId,
        state: "failed",
        message: error instanceof Error ? error.message : "This chat could not be loaded.",
      });
    });
  }, [
    connection.snapshot?.activeConversationId,
    connection.status,
    conversation?.latestTurn?.updatedAt,
    conversation?.updatedAt,
    conversationDetailRefresh,
    request,
  ]);

  useEffect(() => {
    if (!conversationDetail) return;
    const plan = conversationDetail.plans.at(-1);
    if (!plan) return;
    setNativePlans((current) => ({ ...current, [conversationDetail.conversation.id]: plan }));
  }, [conversationDetail]);

  useEffect(() => {
    const run = visibleConversationRun;
    if (!run || pendingSeenRunsRef.current.has(run.id)) return;
    const shouldMark = shouldMarkWorkspaceRunSeen(
      run,
      view === "workspace" ? conversation?.id ?? null : null,
      {
        documentVisible: document.visibilityState === "visible",
        documentFocused: document.hasFocus(),
        workspaceVisible: view === "workspace",
        latestContentVisible,
        obstructed: activityOpen
          || paletteOpen
          || commitDialogOpen
          || authProviderId !== null
          || (mobileNavigation && sidebarOpen),
      },
    );
    if (!shouldMark) return;
    pendingSeenRunsRef.current.add(run.id);
    void request({
      type: "activity.mark-seen",
      payload: { runId: run.id },
    }).catch(() => undefined).finally(() => {
      pendingSeenRunsRef.current.delete(run.id);
    });
  }, [
    activityOpen,
    attentionVisibilityVersion,
    authProviderId,
    commitDialogOpen,
    conversation?.id,
    latestContentVisible,
    mobileNavigation,
    paletteOpen,
    request,
    sidebarOpen,
    view,
    visibleConversationRun,
  ]);

  useEffect(() => connection.subscribe((event) => {
    if (event.type === "server.welcome") {
      // A full welcome is an authoritative projection replacement (initial
      // load, generation change, or unreplayable gap). Never merge the prior
      // runtime's detail/transient state into the replacement shell.
      detailRequestGenerationRef.current += 1;
      setConversationDetailState(null);
      setStreamingText("");
      setStreamingReasoning("");
      setLiveUsage({});
      setLiveActivities({});
      setPendingApprovals([]);
      setPendingInputs([]);
      setNativePlans({});
      pendingSeenRunsRef.current.clear();
      return;
    }
    if (event.type === "agent.approval.requested") {
      setPendingApprovals((current) => [...current.filter(({ id }) => id !== event.request.id), event.request]);
      if (event.request.conversationId === conversation?.id) setStreamingText("");
      return;
    }
    if (event.type === "agent.approval.resolved") {
      setPendingApprovals((current) => current.filter(({ id }) => id !== event.requestId));
      return;
    }
    if (event.type === "agent.input.requested") {
      setPendingInputs((current) => [...current.filter(({ id }) => id !== event.request.id), event.request]);
      if (event.request.conversationId === conversation?.id) setStreamingText("");
      return;
    }
    if (event.type === "agent.input.resolved") {
      setPendingInputs((current) => current.filter(({ id }) => id !== event.requestId));
      return;
    }
    if (event.type === "agent.plan.updated") {
      setNativePlans((current) => ({ ...current, [event.plan.conversationId]: event.plan }));
      if (event.plan.conversationId === conversation?.id) setStreamingText("");
      if (settings.autoOpenPlan && event.plan.conversationId === conversation?.id) setActiveTool("plan");
      return;
    }
    if (event.type === "agent.usage") {
      setLiveUsage((current) => ({ ...current, [event.usage.conversationId]: event.usage }));
      return;
    }
    if (event.type === "agent.activity") {
      setLiveActivities((current) => {
        const existing = current[event.activity.conversationId] ?? [];
        return {
          ...current,
          [event.activity.conversationId]: [...existing.filter(({ id }) => id !== event.activity.id), event.activity].slice(-100),
        };
      });
      if (event.activity.conversationId === conversation?.id) setStreamingText("");
      return;
    }
    if (!conversation || !("conversationId" in event) || event.conversationId !== conversation.id) return;
    if (event.type === "agent.started") { setStreamingText(""); setStreamingReasoning(""); }
    if (event.type === "agent.text") setStreamingText((current) => `${current}${event.text}`.slice(-500_000));
    if (event.type === "agent.reasoning") {
      setStreamingReasoning((current) => `${current}${event.text}`.slice(-500_000));
    }
    if (event.type === "agent.completed" || event.type === "agent.failed") {
      setStreamingText("");
      setStreamingReasoning("");
      setGitRefreshVersion((current) => current + 1);
    }
  }), [connection.subscribe, conversation, settings.autoOpenPlan]);

  useEffect(() => {
    setStreamingText("");
    setStreamingReasoning("");
    setPendingDiffContext(null);
    setLastDiffReversal(null);
    setHistoricalDiff(null);
    setHistoricalSelectedPath(null);
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
    if (!project?.id) return;
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
  }, [conversation?.id, project?.id, request, settings.ignoreWhitespace]);

  const loadFiles = useCallback(async (query?: string) => {
    if (!project?.id) return;
    const event = resultEvent(await request({ type: "workspace.entries", payload: { projectId: project.id, conversationId: conversation?.id, ...(query?.trim() ? { query: query.trim() } : {}) } }));
    if (event.result.kind !== "workspace.entries") throw new Error("Unexpected file response.");
    setWorkspaceEntries(event.result.entries);
    setEntriesTruncated(event.result.truncated);
  }, [conversation?.id, project?.id, request]);

  const loadActions = useCallback(async () => {
    if (!project?.id) return;
    try {
      const event = resultEvent(await request({ type: "project.actions", payload: { projectId: project.id, conversationId: conversation?.id } }));
      if (event.result.kind === "project.actions") setProjectActions(event.result.actions);
    } catch { setProjectActions([]); }
  }, [conversation?.id, project?.id, request]);

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
  }, [connection.status, conversation?.id, gitRefreshVersion, loadActions, loadFiles, loadGit, project?.id]);

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
  const activateActivityContext = (activity: WorkspaceRun, tool?: WorkspacePanelTab) => {
    const targetConversation = connection.snapshot?.conversations.find(({ id }) => id === activity.conversationId);
    const targetProject = connection.snapshot?.projects.find(({ id }) => id === activity.projectId);
    if (targetConversation) selectConversation(targetConversation);
    else if (targetProject) selectProject(targetProject);
    setView("workspace");
    setSidebarOpen(false);
    if (tool) setActiveTool(tool);
  };
  const createConversation = (
    targetProject: Project | null = project,
    location: NewConversationLocation = { kind: "defaults" },
  ) => {
    if (!targetProject) return;
    const backendDefault = connection.snapshot?.backendDefaults?.find(
      ({ scope, projectId }) =>
        scope === "project" && projectId === targetProject.id,
    ) ?? connection.snapshot?.backendDefaults?.find(({ scope }) =>
      scope === "global");
    const defaultPayload = buildNewConversationPayload(
      targetProject.id,
      settings,
      location,
    );
    const payload: ConversationCreatePayload = backendDefault
      ? withNewConversationModelSelection(
        defaultPayload,
        backendDefault.selection,
      )
      : defaultPayload;
    const select = targetProject.id === project?.id ? Promise.resolve() : run("project.select", { type: "project.select", payload: { projectId: targetProject.id } });
    void select
      .then(() => run("conversation.create", {
        type: "conversation.create",
        payload,
      }))
      .then(() => { setView("workspace"); setSidebarOpen(false); })
      .catch(() => undefined);
  };
  const createConversationForSelection = async (
    selection: ModelSelection,
  ): Promise<void> => {
    if (!project) throw new Error("Select a project before creating a chat.");
    await run("conversation.create", {
      type: "conversation.create",
      payload: withNewConversationModelSelection(
        buildNewConversationPayload(project.id, settings),
        selection,
      ),
    });
    setView("workspace");
    setSidebarOpen(false);
  };
  const sendMessage = async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => {
    if (!conversation) return;
    await run("message.send", {
      type: "message.send",
      payload: {
        conversationId: conversation.id,
        content,
        attachments,
        ...(context ? { context } : {}),
      },
    });
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
  const updateConversation = (update: Partial<Pick<Conversation, "providerId" | "modelSelection" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => {
    if (!conversation) return;
    const { modelSelection, ...legacyUpdate } = update;
    const payload = modelSelection
      ? {
          ...legacyUpdate,
          modelSelection: {
            ...modelSelection,
            providerOptions: { ...modelSelection.providerOptions },
            capabilities: modelSelection.capabilities.map((capability) => ({ ...capability })),
          },
        }
      : legacyUpdate;
    void run("conversation.update", { type: "conversation.update", payload: { conversationId: conversation.id, ...payload } }).catch(() => undefined);
  };
  const updateSettings = async (updates: Partial<AppSettings>): Promise<void> => {
    await run("settings.update", { type: "settings.update", payload: updates }).catch(() => undefined);
  };
  const backendProfileResult = (event: ServerEvent): ModelBackendProfileDetail => {
    const result = resultEvent(event).result;
    if (
      result.kind !== "backend.profile"
      && result.kind !== "backend.profile.probe"
    ) {
      throw new Error("The local service returned an unexpected backend profile response.");
    }
    return result.profile;
  };
  const loadBackendProfile = async (
    profileId: string,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await request({
      type: "backend.profile.get",
      payload: { profileId },
    }));
  const createBackendProfile = async (
    draft: ModelBackendProfileDraft,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.create", {
      type: "backend.profile.create",
      payload: backendProfileCreatePayload(draft),
    }));
  const updateBackendProfile = async (
    profileId: string,
    update: Partial<ModelBackendProfileDraft> & { enabled?: boolean },
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.update", {
      type: "backend.profile.update",
      payload: { profileId, update: backendProfileUpdatePayload(update) },
    }));
  const reconcileBackendCredential = async (
    profileId: string,
    credentialGeneration: string | null,
  ): Promise<ModelBackendProfileDetail> => {
    if (!credentialGeneration) {
      throw new Error("Secure credential storage did not return a mutation generation.");
    }
    return backendProfileResult(await run("backend.profile.credential-revision", {
      type: "backend.profile.credential-revision",
      payload: { profileId, credentialGeneration },
    }));
  };
  const setBackendCredential = async (
    profileId: string,
    secret: string,
  ): Promise<ModelBackendProfileDetail> => {
    const state = await window.inertia.setBackendCredential({ profileId, secret });
    return await reconcileBackendCredential(profileId, state.credentialGeneration);
  };
  const clearBackendCredential = async (
    profileId: string,
  ): Promise<ModelBackendProfileDetail> => {
    const state = await window.inertia.clearBackendCredential({ profileId });
    return await reconcileBackendCredential(profileId, state.credentialGeneration);
  };
  const probeBackendProfile = async (
    profileId: string,
    modelId: string,
  ): Promise<ModelBackendProfileDetail> =>
    backendProfileResult(await run("backend.profile.probe", {
      type: "backend.profile.probe",
      payload: { profileId, modelId },
    }));
  const deleteBackendProfile = async (profileId: string): Promise<void> => {
    await run("backend.profile.delete", {
      type: "backend.profile.delete",
      payload: { profileId },
    });
  };
  const setBackendDefault = async (
    projectId: string | null,
    selection: ModelSelection,
  ): Promise<void> => {
    await run("backend.default.set", {
      type: "backend.default.set",
      payload: {
        projectId,
        selection: {
          ...selection,
          providerOptions: { ...selection.providerOptions },
          capabilities: selection.capabilities.map((capability) => ({ ...capability })),
        },
      },
    });
  };
  const clearBackendDefault = async (projectId: string | null): Promise<void> => {
    await run("backend.default.clear", {
      type: "backend.default.clear",
      payload: { projectId },
    });
  };
  const chooseCodexBinary = async (): Promise<void> => {
    const path = await window.inertia.selectCodexExecutable();
    if (path) await updateSettings({ codexBinaryPath: path });
  };
  const cycleTheme = () => updateSettings({
    theme: nextQuickTheme(settings.theme, window.matchMedia("(prefers-color-scheme: dark)").matches),
  });
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
  const commit = async (message: string, push: boolean, paths: string[]) => {
    if (!project) return;
    if (paths.length === 0) throw new Error("Select at least one path to commit.");
    await run("git.commit", { type: "git.commit", payload: { projectId: project.id, conversationId: conversation?.id, message, paths } });
    if (push) await run("git.push", { type: "git.push", payload: { projectId: project.id, conversationId: conversation?.id } });
    setCommitDialogOpen(false); await loadGit();
  };
  const selectChangedFile = (path: string) => {
    setSelectedChange(path);
  };
  const askAboutDiff = async (selection: DiffSelection, comment: string) => {
    if (!project || !conversation) return;
    setSelectionReviewAnswer(null);
    const event = await run("review.selection.ask", { type: "review.selection.ask", payload: {
      projectId: project.id,
      conversationId: conversation.id,
      fingerprint: selection.fingerprint,
      filePath: selection.file.path,
      hunkId: selection.hunk.id,
      lineIds: selection.lineIds,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ignoreWhitespace: settings.ignoreWhitespace,
    } });
    if (event.type === "request.ok") return;
    const result = resultEvent(event).result;
    if (result.kind !== "review.selection.answer") {
      throw new Error("The local service returned an unexpected review answer.");
    }
    setSelectionReviewAnswer(result.answer);
  };
  const requestDiffRevision = async (selection: DiffSelection, comment: string) => {
    if (!project || !conversation) return;
    await run("review.selection.revise", { type: "review.selection.revise", payload: {
      projectId: project.id,
      conversationId: conversation.id,
      fingerprint: selection.fingerprint,
      filePath: selection.file.path,
      hunkId: selection.hunk.id,
      lineIds: selection.lineIds,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ignoreWhitespace: settings.ignoreWhitespace,
    } });
  };
  const setDiffReviewState = async (state: Omit<DiffReviewState, "conversationId" | "stale" | "updatedAt">) => {
    if (!conversation) return;
    await run("review.state.set", { type: "review.state.set", payload: {
      conversationId: conversation.id,
      scope: state.scope,
      path: state.path,
      hunkId: state.hunkId,
      targetFingerprint: state.targetFingerprint,
      reviewed: state.reviewed,
      ignoreWhitespace: settings.ignoreWhitespace,
    } });
  };
  const createDiffReviewNote = async (note: Omit<DiffReviewNote, "id" | "conversationId" | "stale" | "createdAt" | "updatedAt">) => {
    if (!conversation) return;
    await run("review.note.create", { type: "review.note.create", payload: {
      conversationId: conversation.id,
      path: note.path,
      hunkId: note.hunkId,
      lineIds: note.lineIds,
      targetFingerprint: note.targetFingerprint,
      body: note.body,
      ignoreWhitespace: settings.ignoreWhitespace,
    } });
  };
  const updateDiffReviewNote = async (noteId: string, body: string) => {
    if (!conversation) return;
    await run("review.note.update", { type: "review.note.update", payload: { conversationId: conversation.id, noteId, body } });
  };
  const deleteDiffReviewNote = async (noteId: string) => {
    if (!conversation) return;
    await run("review.note.delete", { type: "review.note.delete", payload: { conversationId: conversation.id, noteId } });
  };
  const revertDiffSelection = async (selection: DiffSelection, comment: string) => {
    if (!project) return;
    const inspected = resultEvent(await run("git.selection.inspect", { type: "git.selection.inspect", payload: {
      projectId: project.id,
      ...(conversation ? { conversationId: conversation.id } : {}),
      fingerprint: selection.fingerprint,
      filePath: selection.file.path,
      hunkId: selection.hunk.id,
      lineIds: selection.lineIds,
      ignoreWhitespace: settings.ignoreWhitespace,
    } }));
    if (inspected.result.kind !== "git.reversal.plan") throw new Error("The local service returned an unexpected reversal plan.");
    const plan = inspected.result.plan;
    if (settings.confirmDestructiveActions) {
      const layers = plan.affectedLayers.map((layer) => layer === "index" ? "Git index (staged)" : "working tree").join(" and ");
      const confirmed = window.confirm([
        `Revert ${plan.changedLineCount} changed ${plan.changedLineCount === 1 ? "line" : "lines"} in ${plan.filePath}?`,
        "",
        `Hunk: ${plan.hunkHeader}`,
        `Selected lines: ${plan.selectedLineCount}`,
        `Affected Git layers: ${layers}`,
        "",
        "Inertia will create an immediate reversible backup before changing either layer.",
      ].join("\n"));
      if (!confirmed) return;
    }
    const reversed = resultEvent(await run("git.selection.revert", { type: "git.selection.revert", payload: {
      projectId: project.id,
      ...(conversation ? { conversationId: conversation.id } : {}),
      fingerprint: selection.fingerprint,
      filePath: selection.file.path,
      hunkId: selection.hunk.id,
      lineIds: selection.lineIds,
      expected: plan.validation,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      ignoreWhitespace: settings.ignoreWhitespace,
    } }));
    if (reversed.result.kind !== "git.reversal") throw new Error("The local service returned an unexpected reversal result.");
    setGitDiff(reversed.result.diff);
    setLastDiffReversal(reversed.result.operation);
    await loadGit();
  };
  const undoDiffReversal = async () => {
    if (!project || !lastDiffReversal) return;
    const restored = resultEvent(await run("git.selection.undo", { type: "git.selection.undo", payload: {
      projectId: project.id,
      ...(conversation ? { conversationId: conversation.id } : {}),
      operationId: lastDiffReversal.id,
    } }));
    if (restored.result.kind !== "git.diff") throw new Error("The local service returned an unexpected Undo result.");
    setGitDiff(restored.result.diff);
    setLastDiffReversal(null);
    await loadGit();
  };
  const generateReviewSummary = async () => {
    if (!project || !conversation || structuredDiff.files.length === 0) return;
    await run("review.summary.generate", { type: "review.summary.generate", payload: {
      projectId: project.id,
      conversationId: conversation.id,
      fingerprint: structuredDiff.fingerprint,
      ignoreWhitespace: settings.ignoreWhitespace,
    } });
  };
  const cancelReviewSummary = async () => {
    if (!conversation) return;
    await request({ type: "review.summary.cancel", payload: { conversationId: conversation.id } });
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
  const openProjectPath = useCallback((
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => {
    void window.inertia.openProjectPath(request)
      .then((error) => { if (error) setActionError(error); })
      .catch((error) => setActionError(error instanceof Error ? error.message : "The project path could not be opened."));
  }, []);
  const openTurnDiff = useCallback(async (turnId: string, path?: string) => {
    if (!project || !conversation) return;
    setToolsLoading(true);
    try {
      const event = resultEvent(await request({
        type: "git.turn.diff",
        payload: {
          projectId: project.id,
          conversationId: conversation.id,
          turnId,
          ...(path ? { path } : {}),
        },
      }));
      if (event.result.kind !== "git.turn.diff") {
        throw new Error("The local service returned an unexpected historical diff.");
      }
      setHistoricalDiff(event.result.diff);
      setHistoricalSelectedPath(
        path && event.result.diff.files.some((file) => file.path === path)
          ? path
          : event.result.diff.files[0]?.path ?? null,
      );
      setActiveTool("changes");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The historical diff could not be opened.");
    } finally {
      setToolsLoading(false);
    }
  }, [conversation, project, request]);
  const compareTurnArtifacts = useCallback(async (
    earlierTurnId: string,
    laterTurnId: string,
  ) => {
    if (!project || !conversation) return;
    setToolsLoading(true);
    try {
      const event = resultEvent(await request({
        type: "git.turn.compare",
        payload: {
          projectId: project.id,
          conversationId: conversation.id,
          earlierTurnId,
          laterTurnId,
        },
      }));
      if (event.result.kind !== "git.turn.diff") {
        throw new Error("The local service returned an unexpected turn comparison.");
      }
      setHistoricalDiff(event.result.diff);
      setHistoricalSelectedPath(event.result.diff.files[0]?.path ?? null);
      setActiveTool("changes");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The turn comparison could not be opened.");
    } finally {
      setToolsLoading(false);
    }
  }, [conversation, project, request]);
  const openTurnFile = useCallback((path: string) => {
    if (!project) return;
    openProjectPath({
      projectId: project.id,
      ...(conversation ? { conversationId: conversation.id } : {}),
      relativePath: path,
      action: "open-externally",
    });
  }, [conversation, openProjectPath, project]);

  useEffect(() => {
    if (!pendingActivityAction?.actionId || project?.id !== pendingActivityAction.projectId) return;
    if (pendingActivityAction.conversationId && conversation?.id !== pendingActivityAction.conversationId) return;
    setPendingActionId(pendingActivityAction.actionId);
    setPendingActivityAction(null);
  }, [conversation?.id, pendingActivityAction, project?.id]);

  const openActivityLocation = (activity: WorkspaceRun) => {
    const targetProject = connection.snapshot?.projects.find(({ id }) => id === activity.projectId);
    const targetConversation = connection.snapshot?.conversations.find(({ id }) => id === activity.conversationId);
    if (!targetProject) return;
    openProjectPath({
      projectId: targetProject.id,
      ...(targetConversation ? { conversationId: targetConversation.id } : {}),
      relativePath: ".",
      action: "open-externally",
    });
  };
  const openActivityPreview = (activity: WorkspaceRun) => {
    if (!activity.port) return;
    activateActivityContext(activity, "preview");
    navigatePreview(`http://127.0.0.1:${activity.port}`);
    setActivityOpen(false);
  };
  const stopActivity = (activity: WorkspaceRun) => {
    void run(`activity.stop:${activity.id}`, {
      type: "activity.stop",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : "The run could not be stopped.";
      setActionError(`Could not stop ${activity.label}: ${detail}`);
    });
  };
  const rerunActivity = (activity: WorkspaceRun) => {
    if (!activity.actionId) return;
    setPendingActivityAction(activity);
    activateActivityContext(activity, "terminal");
    setActivityOpen(false);
  };
  const markActivitySeen = (activity: WorkspaceRun) => {
    void request({
      type: "activity.mark-seen",
      payload: { runId: activity.id },
    }).catch(() => undefined);
  };
  const acknowledgeActivity = (activity: WorkspaceRun) => {
    void run(`activity.acknowledge:${activity.id}`, {
      type: "activity.acknowledge",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : "The run could not be acknowledged.";
      setActionError(`Could not acknowledge ${activity.label}: ${detail}`);
    });
  };
  const dismissActivity = (activity: WorkspaceRun) => {
    void run(`activity.dismiss:${activity.id}`, {
      type: "activity.dismiss",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error ? error.message : "The run could not be dismissed.";
      setActionError(`Could not dismiss ${activity.label}: ${detail}`);
    });
  };

  const visibleError = actionError ?? connection.error;
  const visibleConversationDetailState = conversationDetailState?.conversationId === conversation?.id
    ? conversationDetailState
    : null;
  const detailUnavailable = visibleConversationDetailState
    && visibleConversationDetailState.state !== "loading"
    && visibleConversationDetailState.state !== "ready"
      ? visibleConversationDetailState
      : null;
  const detailLoading = Boolean(
    conversation
    && (!visibleConversationDetailState || visibleConversationDetailState.state === "loading"),
  );
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
    <div ref={appShellRef} className={`app-shell platform-${platform}${sidebarCollapsed && !mobileNavigation ? " is-sidebar-collapsed" : ""}`} data-interface-scale={settings.interfaceScale} data-runtime-generation={connection.runtimeGeneration ?? undefined} data-connection-status={connection.status} style={appShellStyle}>
      {(mobileNavigation || !sidebarCollapsed) && <Sidebar
        snapshot={connection.snapshot} connectionStatus={connection.status} view={view} open={sidebarOpen} busy={busyAction === "project.create"}
        onClose={() => setSidebarOpen(false)} onViewChange={setView} onImportProject={() => void importProject()} onSelectProject={selectProject} onSelectConversation={selectConversation} onCreateConversation={createConversation}
        onRenameConversation={(thread, title) => { void run("conversation.update", { type: "conversation.update", payload: { conversationId: thread.id, title } }).catch(() => undefined); }}
        onArchiveConversation={(thread) => { void run("conversation.archive", { type: "conversation.archive", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onSettleConversation={(thread) => { void run("conversation.settle", { type: "conversation.settle", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onRestoreConversation={(thread) => { void run("conversation.unsettle", { type: "conversation.unsettle", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onDeleteConversation={(thread) => { if (!settings.confirmDestructiveActions || window.confirm(`Delete “${thread.title}”? This cannot be undone.`)) void run("conversation.delete", { type: "conversation.delete", payload: { conversationId: thread.id } }).catch(() => undefined); }}
        onAcknowledgeRun={acknowledgeActivity}
        onDismissRun={dismissActivity}
        onOpenProject={(item) => openProjectPath({ projectId: item.id, relativePath: ".", action: "open-externally" })}
        onRenameProject={(item, name) => { void run("project.update", { type: "project.update", payload: { projectId: item.id, name } }).catch(() => undefined); }}
        onSetProjectGrouping={(item, groupingMode) => { void run("project.update", { type: "project.update", payload: { projectId: item.id, groupingMode } }).catch(() => undefined); }}
        onSidebarModeChange={(sidebarMode) => updateSettings({ sidebarMode })}
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

      <section
        className="workspace-shell"
        id="main-workspace"
        inert={mobileNavigation && sidebarOpen ? true : undefined}
      >
        <div className="workspace-frame">
          <WorkspaceHeader
            project={project} conversation={conversation} view={view} activeTool={activeTool} sidebarCollapsed={sidebarCollapsed} theme={settings.theme} gitStatus={gitStatus} branches={branches} actions={projectActions} busy={Boolean(busyAction)}
            activityOpen={activityOpen} activeRunCount={runsSummary.activeCount} attentionRunCount={runsSummary.attentionCount}
            onOpenSidebar={() => { if (mobileNavigation) setSidebarOpen(true); else setSidebarCollapsed((collapsed) => !collapsed); }} onToggleTools={() => setActiveTool((tool) => tool ? null : "terminal")} onCycleTheme={cycleTheme} onOpenSettings={() => setView("settings")}
            onToggleActivity={() => setActivityOpen((open) => !open)}
            onOpenProject={() => { if (project) openProjectPath({ projectId: project.id, relativePath: ".", action: "open-externally" }); }} onRefreshBranches={loadBranches}
            onSwitchBranch={(name) => mutateBranch("git.branch.switch", name)} onCreateBranch={(name) => mutateBranch("git.branch.create", name)} onCommit={() => setCommitDialogOpen(true)} onRunAction={runProjectAction}
            onCreateConversationOnBranch={(branch) => createConversation(project, { kind: "branch", branch })}
            onCreateConversationInWorktree={() => {
              if (conversation?.worktreePath) {
                createConversation(project, { kind: "worktree", branch: gitStatus?.branch ?? conversation.branch, path: conversation.worktreePath });
              }
            }}
            onCreateConversationInIsolatedWorktree={() => createConversation(project, { kind: "isolated-worktree" })}
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
                backendProfiles={connection.snapshot?.backendProfiles ?? []}
                backendDefaults={connection.snapshot?.backendDefaults ?? []}
                projects={connection.snapshot?.projects ?? []}
                archived={connection.snapshot?.conversations.filter(({ archivedAt }) => archivedAt !== null) ?? []}
                onUpdate={updateSettings}
                onConnectProvider={connectProvider}
                onRefreshProvider={refreshProvider}
                onChooseCodexBinary={() => { void chooseCodexBinary().catch(() => undefined); }}
                onRevealRuntimeLogs={() => window.inertia.revealRuntimeLogs()}
                onUnarchive={(thread) => { void run("conversation.unarchive", { type: "conversation.unarchive", payload: { conversationId: thread.id } }).catch(() => undefined); }}
                onLoadBackendProfile={loadBackendProfile}
                onCreateBackendProfile={createBackendProfile}
                onUpdateBackendProfile={updateBackendProfile}
                onSetBackendCredential={setBackendCredential}
                onClearBackendCredential={clearBackendCredential}
                onProbeBackendProfile={probeBackendProfile}
                onDeleteBackendProfile={deleteBackendProfile}
                onSetBackendDefault={setBackendDefault}
                onClearBackendDefault={clearBackendDefault}
              />
            ) : detailUnavailable ? (
              <ConversationDetailState
                state={detailUnavailable.state}
                message={detailUnavailable.state === "failed" ? detailUnavailable.message : undefined}
                onRetry={() => setConversationDetailRefresh((version) => version + 1)}
              />
            ) : (
              <ChatWorkspace project={project} conversation={conversationDetail?.conversation ?? null} turns={turns} messages={messages} activities={activities} reasonings={reasonings} plans={plans} checkpoints={checkpoints} turnGitArtifacts={turnGitArtifacts} streamingText={streamingText} streamingReasoning={streamingReasoning} usage={usage} approvals={pendingApprovals.filter((request) => request.conversationId === conversation?.id)} inputRequests={pendingInputs.filter((request) => request.conversationId === conversation?.id)} providers={connection.snapshot?.providers ?? []} backendProfiles={connection.snapshot?.backendProfiles ?? []} actions={projectActions} mentionResults={mentionResults} showTimestamps={settings.showTimestamps} showThinking={settings.showThinking} usageDisplayMode={settings.usageDisplayMode} responseDensity={settings.responseDensity} defaultCodeWrap={settings.defaultCodeWrap} autoCollapseWorkLog={settings.autoCollapseWorkLog} showChangedFileSummaries={settings.showChangedFileSummaries} promptContext={pendingDiffContext} loading={(!connection.snapshot && connection.status !== "offline") || detailLoading} sending={busyAction === "message.send" || busyAction === "review.summary.generate"} onAddProject={() => void importProject()} onCreateConversation={() => createConversation()} onSendMessage={sendMessage} onRespondToApproval={respondToApproval} onRespondToInput={respondToInput} onUpdateConversation={updateConversation} onCreateConversationForSelection={createConversationForSelection} onChooseAttachments={chooseComposerAttachments} onImportAttachments={importComposerAttachments} onRunAction={runProjectAction} onMentionQuery={searchMentions} onConnectProvider={connectProvider} onRefreshProvider={refreshProvider} onUsageDisplayModeChange={(usageDisplayMode) => void updateSettings({ usageDisplayMode })} onClearPromptContext={() => setPendingDiffContext(null)} onLatestContentVisibilityChange={setLatestContentVisible} onOpenTurnDiff={(turnId, path) => { void openTurnDiff(turnId, path); }} onCompareTurnArtifacts={(earlierTurnId, laterTurnId) => { void compareTurnArtifacts(earlierTurnId, laterTurnId); }} onOpenTurnFile={openTurnFile} onRevertCheckpoint={(checkpoint) => { if (conversation && (!settings.confirmDestructiveActions || window.confirm("Restore the project to before this turn? Untracked files created later will be left in place."))) void run("checkpoint.revert", { type: "checkpoint.revert", payload: { conversationId: conversation.id, checkpointId: checkpoint.id } }).then(() => loadGit()).catch(() => undefined); }} onStop={() => { if (conversation) void run("agent.stop", { type: "agent.stop", payload: { conversationId: conversation.id } }).catch(() => undefined); }} />
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
                {activeTool === "changes" && (historicalDiff
                  ? <HistoricalDiffPanel diff={historicalDiff} selectedPath={historicalSelectedPath} wrapLines={settings.wrapDiffs} onSelectFile={setHistoricalSelectedPath} onOpenFile={openTurnFile} onShowCurrentChanges={() => { setHistoricalDiff(null); setHistoricalSelectedPath(null); void loadGit().catch((error) => setActionError(error instanceof Error ? error.message : "Changes could not be refreshed.")); }} />
                  : <ChangesPanel files={gitStatus?.files ?? []} diff={gitDiff} selectedPath={selectedChange} summary={reviewSummary} selectionAnswer={selectionReviewAnswer} reviewStates={reviewStates} notes={reviewNotes} loading={toolsLoading} summaryLoading={busyAction === "review.summary.generate"} wrapLines={settings.wrapDiffs} lastReversal={lastDiffReversal} onSelectFile={selectChangedFile} onRefresh={() => void loadGit().catch((error) => setActionError(error instanceof Error ? error.message : "Changes could not be refreshed."))} onGenerateSummary={generateReviewSummary} onCancelSummary={cancelReviewSummary} onAsk={askAboutDiff} onRequestRevision={requestDiffRevision} onRevert={revertDiffSelection} onUndoReversal={undoDiffReversal} onDismissSelectionAnswer={() => setSelectionReviewAnswer(null)} onSetReviewState={setDiffReviewState} onCreateNote={createDiffReviewNote} onUpdateNote={updateDiffReviewNote} onDeleteNote={deleteDiffReviewNote} onAddTextToPrompt={setPendingDiffContext} onAddToPrompt={(selection) => setPendingDiffContext(selection.reference)} />)}
                {activeTool === "files" && <FilesPanel entries={workspaceEntries} preview={filePreview} selectedPath={selectedFile} loading={toolsLoading} entriesTruncated={entriesTruncated} onSelectFile={selectWorkspaceFile} onRefresh={() => void loadFiles().catch((error) => setActionError(error instanceof Error ? error.message : "Files could not be refreshed."))} onSearchChange={searchFiles} onOpenFile={(path) => openProjectPath({ projectId: project.id, ...(conversation ? { conversationId: conversation.id } : {}), relativePath: path, action: "open-externally" })} />}
                <TerminalPanel key={`${project.id}:${conversation?.id ?? "project"}`} visible={toolsVisible && activeTool === "terminal"} projectId={project.id} conversationId={conversation?.id} projectName={project.name} status={connection.status} fontSize={settings.terminalFontSize} theme={settings.theme} sendCommand={connection.sendCommand} subscribe={connection.subscribe} actionId={pendingActionId} onActionStarted={() => setPendingActionId(null)} onClose={() => setActiveTool(null)} />
                {activeTool === "plan" && <PlanPanel steps={planSteps} summary={conversation && nativePlans[conversation.id]?.explanation ? nativePlans[conversation.id].explanation! : conversation?.interactionMode === "plan" ? "The latest agent response is reflected as a working plan." : "Switch the composer to Plan mode and ask the agent to propose an approach."} onRefine={conversation && conversation.status !== "running" && conversation.status !== "needs-input" ? () => { updateConversation({ interactionMode: "plan" }); void sendMessage("Refine the implementation plan with clearer steps, risks, and validation.", []).catch(() => undefined); } : undefined} onImplement={conversation && planSteps.length > 0 && conversation.status !== "running" && conversation.status !== "needs-input" ? () => { updateConversation({ interactionMode: "build" }); void sendMessage("Implement the plan above and validate the result.", []).catch(() => undefined); setActiveTool("changes"); } : undefined} />}
                {activeTool === "preview" && <PreviewPanel url={previewUrl} loading={previewNavigation.loading} canGoBack={previewNavigation.canGoBack} canGoForward={previewNavigation.canGoForward} onNavigate={navigatePreview} onBack={() => previewCommand("back")} onForward={() => previewCommand("forward")} onReload={() => previewCommand("reload")} onBoundsChange={setPreviewBounds} onOpenExternal={(url) => { void window.inertia.openExternal(url).catch((error) => setActionError(error instanceof Error ? error.message : "The URL could not be opened.")); }} />}
              </WorkspacePanel>
            )}
          </div>
        </div>
      </section>

      <CommitDialog open={commitDialogOpen} status={gitStatus} reviewStates={reviewStates} diff={structuredDiff} busy={busyAction === "git.commit" || busyAction === "git.push"} onClose={() => setCommitDialogOpen(false)} onCommit={commit} />
      <ActivityCenter
        open={activityOpen}
        now={activityNow}
        runs={connection.snapshot?.runs ?? []}
        projects={connection.snapshot?.projects ?? []}
        conversations={connection.snapshot?.conversations ?? []}
        onClose={() => setActivityOpen(false)}
        onOpenThread={(thread) => { selectConversation(thread); setView("workspace"); setActivityOpen(false); }}
        onOpenLocation={openActivityLocation}
        onOpenTerminal={(activity) => { activateActivityContext(activity, "terminal"); setActivityOpen(false); }}
        onOpenPreview={openActivityPreview}
        onStop={stopActivity}
        onRerun={rerunActivity}
        onMarkSeen={markActivitySeen}
        onAcknowledge={acknowledgeActivity}
        onDismiss={dismissActivity}
      />
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
