import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  InterfaceScale,
  ResponseDensity,
} from "@shared/contracts";
import {
  buildTurnExecutionStream,
  followUpAnswers,
  isTranscriptActivity,
  type TurnExecutionStreamEntry,
} from "./execution";
import { latestFailureIndex, resolveActivityGroupWindow } from "./activity-summary";
import {
  isQuietSettledTurn,
  needsStaticFoldRow,
  shouldFoldSettledTurn,
  turnHasFoldableWork,
} from "./fold";
import type {
  ResponseTimelineItem,
  ResponseTurn,
  TurnGitArtifactSummary,
} from "./model";
import {
  collapsedUserRequestPreview,
  shouldCollapseUserRequest,
} from "../userRequestPresentation";
import { watcherCheckTitle } from "../watcherLinks";

export const TIMELINE_VIRTUALIZATION_MIN_ROWS = 14;
export const TIMELINE_VIRTUALIZATION_MIN_WEIGHTED_ROWS = 10;
export const TIMELINE_VIRTUALIZATION_MIN_WEIGHT = 10;
export const TIMELINE_MINIMAP_MIN_GUTTER = 48;
// Keep long conversations legible without collapsing ten or more turns into
// each marker. The rail remains bounded and scrollable in shorter viewports.
export const TIMELINE_MINIMAP_MAX_MARKERS = 40;
const WATCHER_NOTE_ROW_HEIGHT = 64;
const USER_REQUEST_META_HEIGHT = 28;
const SUBAGENT_GROUP_ROW_HEIGHT = 52;
const WATCHER_WAKE_REQUEST_HEIGHT = 44;
const DUO_COMPARISON_REQUEST_HEIGHT = 136;
export const DUO_COMPARISON_REQUEST_LABEL = "Comparing A and B";

/**
 * Row count alone misses short-but-expensive histories. A turn containing
 * hundreds of activities or megabytes of bounded diagnostics can cost more to
 * mount than dozens of ordinary answers, so the viewport also considers a
 * cheap structural weight derived from already-projected data.
 */
export function estimateTimelineRenderWeight(
  timeline: readonly ResponseTimelineItem[],
): number {
  return timeline.reduce(
    (weight, item) => weight + estimateTimelineItemRenderWeight(item),
    0,
  );
}

export function estimateTimelineItemRenderWeight(
  item: ResponseTimelineItem,
): number {
  if (item.kind === "compaction") return 1 + item.message.content.length / 400;
  if (item.kind === "handoff" || item.kind === "watcher-note") return 1;
  if (item.kind === "compatibility") {
    const inferredTurnWeight = item.compatibility.inferredTurns.reduce(
      (total, turn) => total + estimateResponseTurnRenderWeight(turn),
      0,
    );
    const textChars = item.compatibility.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );
    const detailChars = item.compatibility.activities.reduce(
      (total, activity) => total + (activity.detail?.length ?? 0),
      0,
    );
    const supportingTextChars = item.compatibility.reasonings.reduce(
      (total, reasoning) => total + reasoning.content.length,
      0,
    ) + estimatePlanTextChars(item.compatibility.plans)
      + item.compatibility.checkpoints.reduce(
        (total, checkpoint) => total + checkpoint.label.length,
        0,
      )
      + item.compatibility.malformedTurns.reduce(
        (total, turn) => total + turn.id.length + turn.status.length,
        0,
      );
    return 1
      + inferredTurnWeight
      + item.compatibility.messages.length / 8
      + item.compatibility.activities.length / 24
      + (textChars + supportingTextChars) / 40_000
      + detailChars / 50_000;
  }
  return estimateResponseTurnRenderWeight(item.turn);
}

function estimatePlanTextChars(plans: ResponseTurn["plans"]): number {
  return plans.reduce(
    (total, plan) => total
      + (plan.explanation?.length ?? 0)
      + plan.steps.reduce((stepTotal, step) => stepTotal + step.step.length, 0),
    0,
  );
}

function estimateResponseTurnRenderWeight(turn: ResponseTurn): number {
  const messageChars = turn.assistantMessages.reduce(
    (total, message) => total + message.content.length,
    (turn.watcherWake || turn.userMessage.duoComparison ? 0 : turn.userMessage.content.length)
      + turn.followUpMessages.reduce(
        (total, message) => total + message.content.length,
        0,
      )
      + turn.systemMessages.reduce(
        (total, message) => total + message.content.length,
        0,
      ),
  ) + turn.reasonings.reduce(
    (total, reasoning) => total + reasoning.content.length,
    0,
  ) + estimatePlanTextChars(turn.plans)
    + (turn.checkpoint?.label.length ?? 0);
  const detailChars = turn.activities.reduce(
    (total, activity) => total + (activity.detail?.length ?? 0),
    0,
  );
  return 1
    + turn.assistantMessages.length / 8
    + turn.activities.length / 24
    + turn.htmlRenders.length / 4
    + messageChars / 40_000
    + detailChars / 50_000;
}

export function shouldVirtualizeTimeline(
  rowCount: number,
  renderWeight = rowCount,
): boolean {
  return Number.isFinite(rowCount)
    && Number.isFinite(renderWeight)
    && (
      rowCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS
      || (
        rowCount >= TIMELINE_VIRTUALIZATION_MIN_WEIGHTED_ROWS
        && renderWeight >= TIMELINE_VIRTUALIZATION_MIN_WEIGHT
      )
    );
}

export function shouldShowTimelineMinimap(rowCount: number, sideGutter: number): boolean {
  return shouldVirtualizeTimeline(rowCount)
    && Number.isFinite(sideGutter)
    && sideGutter >= TIMELINE_MINIMAP_MIN_GUTTER;
}

export function isTurnGitArtifactWithoutChanges(
  artifact: TurnGitArtifactSummary,
): boolean {
  return artifact.status === "ready"
    && artifact.completeness === "complete"
    && artifact.files.length === 0;
}

export function shouldShowTurnGitArtifactSummary(
  artifact: TurnGitArtifactSummary,
): boolean {
  return !(
    artifact.status === "unavailable"
    && artifact.completeness === "unavailable"
    && artifact.absenceReason === "not-repository"
  ) && !isTurnGitArtifactWithoutChanges(artifact);
}

export interface TimelineRowEstimateOptions {
  /** Current transcript width in CSS pixels. Narrow/zoomed layouts wrap sooner. */
  availableWidth?: number;
  /** Persisted interface scale controls transcript column width and typography. */
  interfaceScale?: InterfaceScale;
  /** Response density controls answer leading and inter-turn spacing. */
  responseDensity?: ResponseDensity;
  /** Matches the persisted "Collapse completed work logs" presentation setting. */
  workDetailsExpanded?: boolean;
  /** Models the additional rows revealed by expanded tool-call groups. */
  activityGroupsExpanded?: boolean;
  /** Mirrors whether reasoning summaries are visible inside work details. */
  showThinking?: boolean;
  /** Mirrors whether the changed-file disclosure is enabled and renderable. */
  showChangedFiles?: boolean;
  /** Used when an already-expanded metadata disclosure must be re-estimated. */
  runDetailsExpanded?: boolean;
  /** Used when an already-expanded changed-file disclosure must be re-estimated. */
  changedFilesExpanded?: boolean;
  turnFoldExpanded?: boolean;
  settledSubagentsFoldable?: boolean;
}

function boundedEstimateWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 880;
  return Math.max(320, Math.min(880, value));
}

function estimateTypographyScale(options: TimelineRowEstimateOptions): number {
  const baseFont = {
    compact: 12.5,
    default: 13.5,
    comfortable: 14.5,
    large: 16,
  }[options.interfaceScale ?? "default"];
  const densityAdjustment = {
    compact: 0.5,
    default: 1.5,
    comfortable: 2.5,
  }[options.responseDensity ?? "default"];
  const lineHeight = {
    compact: 1.6,
    default: 1.66,
    comfortable: 1.72,
  }[options.responseDensity ?? "default"];
  return Math.max(0.84, Math.min(1.28, ((baseFont + densityAdjustment) / 15) * (lineHeight / 1.66)));
}

function estimateAnswerMaxWidth(scale: InterfaceScale | undefined): number {
  if (scale === "compact") return 680;
  if (scale === "comfortable" || scale === "large") return 740;
  return 720;
}

function estimateRequestMaxWidth(scale: InterfaceScale | undefined): number {
  if (scale === "compact") return 544;
  if (scale === "comfortable" || scale === "large") return 592;
  return 576;
}

function estimateTurnGap(density: ResponseDensity | undefined): number {
  if (density === "compact") return 28;
  if (density === "comfortable") return 44;
  return 36;
}

export function estimateCompletedTurnSpacing(
  density: ResponseDensity | undefined,
): {
  layer: number;
  footer: number;
  artifact: number;
} {
  if (density === "compact") {
    return { layer: 10, footer: 6, artifact: 1 };
  }
  if (density === "comfortable") {
    return { layer: 15, footer: 10, artifact: 3 };
  }
  return { layer: 12, footer: 8, artifact: 2 };
}

function estimateResponseBlockGap(density: ResponseDensity | undefined): number {
  if (density === "compact") return 13;
  if (density === "comfortable") return 22;
  return 18;
}

function estimatedTextColumns(width: number, maximum: number): number {
  return Math.max(30, Math.min(maximum, Math.floor(width / 7.6)));
}

function estimatedColumnLength(value: string): number {
  let columns = 0;
  const maximumColumns = 48_000;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 9) {
      columns += 4;
      continue;
    }
    let codePoint = codeUnit;
    if (
      codeUnit >= 0xd800
      && codeUnit <= 0xdbff
      && index + 1 < value.length
    ) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing >= 0xdc00 && trailing <= 0xdfff) {
        codePoint = ((codeUnit - 0xd800) * 0x400)
          + trailing - 0xdc00 + 0x10000;
        index += 1;
      }
    }
    columns += codePoint > 0x2e7f ? 2 : 1;
    if (columns >= maximumColumns) return maximumColumns;
  }
  return columns;
}

function estimatedWrappedLines(value: string, columns: number): number {
  if (!value) return 0;
  return value.replace(/\r/gu, "").split("\n").reduce((total, line) =>
    total + Math.max(1, Math.ceil(estimatedColumnLength(line) / columns)), 0);
}

function estimateMarkdownHeight(content: string, columns: number): number {
  if (!content.trim()) return 0;
  const blocks: number[] = [];
  const paragraph: string[] = [];
  let codeLines = 0;
  let inFence = false;
  let listHeight = 0;
  let tableRows = 0;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const lines = estimatedWrappedLines(paragraph.join(" "), columns);
    blocks.push(Math.max(23, lines * 23));
    paragraph.length = 0;
  };
  const flushCode = (): void => {
    if (codeLines === 0) return;
    blocks.push(Math.min(4_800, 18 + codeLines * 20));
    codeLines = 0;
  };
  const flushList = (): void => {
    if (listHeight === 0) return;
    blocks.push(listHeight);
    listHeight = 0;
  };
  const flushTable = (): void => {
    if (tableRows === 0) return;
    blocks.push(24 + tableRows * 36);
    tableRows = 0;
  };
  const flushBlocks = (): void => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const rawLine of content.replace(/\r/gu, "").split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) {
      flushBlocks();
      codeLines += 1;
      inFence = !inFence;
      if (!inFence) flushCode();
      continue;
    }
    if (inFence) {
      codeLines += 1;
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushTable();
      continue;
    }
    const heading = /^(#{1,6})\s/u.exec(trimmed);
    if (heading) {
      flushBlocks();
      const level = heading[1]!.length;
      const lineHeight = level === 1 ? 30 : level === 2 ? 24 : level === 3 ? 20 : 18;
      blocks.push(Math.max(lineHeight, estimatedWrappedLines(trimmed.replace(/^#{1,6}\s+/u, ""), columns) * lineHeight));
      continue;
    }
    if (/^(?:[-+*]|\d+[.)])\s/u.test(trimmed)) {
      flushParagraph();
      flushTable();
      listHeight += (listHeight > 0 ? 6 : 0)
        + Math.max(23, estimatedWrappedLines(trimmed.replace(/^(?:[-+*]|\d+[.)])\s+/u, ""), columns - 4) * 23);
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushBlocks();
      blocks.push(18 + estimatedWrappedLines(trimmed.replace(/^>\s?/u, ""), columns - 4) * 23);
      continue;
    }
    if (/^\|.*\|$/u.test(trimmed)) {
      flushParagraph();
      flushList();
      if (!/^\|(?:\s*:?-+:?\s*\|)+$/u.test(trimmed)) tableRows += 1;
      continue;
    }
    flushList();
    flushTable();
    paragraph.push(trimmed);
  }
  flushBlocks();
  flushCode();
  const contentHeight = blocks.reduce((total, height) => total + height, 0);
  return Math.min(12_000, contentHeight + Math.max(0, blocks.length - 1) * 12);
}

function estimateApprovalHeight(
  approval: AgentApprovalRequest,
  columns: number,
): number {
  const commandHeight = approval.command
    ? Math.min(136, 16 + estimatedWrappedLines(approval.command, Math.max(24, columns - 8)) * 14)
    : approval.detail
      ? estimatedWrappedLines(approval.detail, columns) * 14
      : 0;
  const detailRows = Number(Boolean(approval.reason))
    + Number(Boolean(approval.cwd))
    + Number(Boolean(approval.networkScope))
    + Number(approval.permissionRoots.length > 0);
  return 82 + commandHeight + detailRows * 15;
}

function estimateInputRequestHeight(
  request: AgentInputRequest,
  columns: number,
): number {
  const questionsHeight = request.questions.reduce((total, question) => {
    const legendLines = estimatedWrappedLines(`${question.header} ${question.question}`, columns);
    const optionsHeight = question.options.reduce((optionTotal, option) =>
      optionTotal + 30 + Math.max(0, estimatedWrappedLines(option.description, columns - 8) - 1) * 12, 0);
    const inputHeight = question.options.length === 0 || question.isOther ? 38 : 0;
    return total + 20 + legendLines * 14 + optionsHeight + inputHeight;
  }, 0);
  return 82 + questionsHeight + (request.autoResolutionMs === null ? 0 : 20);
}

function estimateActivityGroupHeight(
  activities: AgentActivity[],
  expanded: boolean,
  windowed = false,
): number {
  if (activities.length === 0) return 0;
  if (activities.length === 1) return 31;
  if (expanded) return 32 + activities.length * 30;
  const live = windowed || activities.some(({ status }) => status === "running");
  const visibleRows = resolveActivityGroupWindow(activities, { expanded: false, settled: !live })
    .filter(({ folded }) => !folded);
  const hiddenRunning = activities.filter(({ status }) => status === "running").length
    - visibleRows.filter(({ activity }) => activity.status === "running").length;
  return 32 + visibleRows.length * 30 + (hiddenRunning > 0 ? 32 : 0);
}

const FAILURE_PROVIDER_FACTS = /^(?:reason|phase|exit code|signal|terminal event|turn|activity|cleanup|last protocol method):/iu;
const FAILURE_CAUSE_FIELDS = /^(?:cause|error|stack):/iu;

function estimateFailurePanelHeight(
  activity: AgentActivity,
  availableWidth: number,
): number {
  let providerFacts = 0;
  let causeLines = 0;
  let contextLines = 0;
  let inContext = false;
  let inStack = false;
  for (const line of (activity.detail ?? "").replace(/\r\n?/gu, "\n").trim().split("\n")) {
    const trimmed = line.trim();
    if (/^Recent provider context:$/iu.test(trimmed)) {
      inContext = true;
      inStack = false;
    } else if (!inContext && FAILURE_PROVIDER_FACTS.test(trimmed)) {
      providerFacts += 1;
      inStack = false;
    } else if (!inContext && FAILURE_CAUSE_FIELDS.test(trimmed)) {
      causeLines += 1;
      inStack = /^stack:/iu.test(trimmed);
    } else if (!inContext && inStack) {
      causeLines += 1;
    } else if (trimmed || contextLines > 0) {
      contextLines += 1;
    }
  }
  const factsHeight = (rows: number): number => rows > 0 ? 16 + rows * 21 : 0;
  const factsGrid = availableWidth <= 664
    ? factsHeight(8) + (providerFacts > 0 ? 12 + factsHeight(providerFacts) : 0)
    : Math.max(factsHeight(8), factsHeight(providerFacts));
  const block = (lines: number): number => lines > 0
    ? 12 + 20 + Math.min(220, 16 + lines * 17)
    : 0;
  return 8 + 28 + 12 + factsGrid + block(causeLines) + block(contextLines) + 29;
}

function estimateExpandedWorkHeight(
  turn: ResponseTurn,
  columns: number,
  includeReasoning: boolean,
  expandActivityGroups: boolean,
): number {
  const streamHeight = turn.isActive
    ? 0
    : buildTurnExecutionStream(turn).reduce((total, entry) => {
        if (entry.kind === "commentary") {
          return total + 10 + estimatedWrappedLines(entry.content, columns) * 18;
        }
        if (entry.kind === "follow-up") {
          return total + 14 + estimatedWrappedLines(entry.message.content, columns - 6) * 18;
        }
        return total + estimateActivityGroupHeight(entry.activities, expandActivityGroups);
      }, 0);
  const reasoningHeight = includeReasoning && turn.reasoning
    ? 22 + estimatedWrappedLines(turn.reasoning.content, columns) * 18
    : 0;
  const planHeight = turn.plans.reduce((total, plan) =>
    total + 26
      + estimatedWrappedLines(plan.explanation ?? "", columns) * 17
      + plan.steps.length * 24, 0);
  return Math.min(6_000, streamHeight + reasoningHeight + planHeight);
}

function estimateTurnRowSize(
  turn: ResponseTurn,
  options: TimelineRowEstimateOptions,
): number {
  const availableWidth = boundedEstimateWidth(options.availableWidth);
  const typographyScale = estimateTypographyScale(options);
  const answerWidth = Math.max(
    280,
    Math.min(estimateAnswerMaxWidth(options.interfaceScale), availableWidth - 40),
  );
  const answerColumns = estimatedTextColumns(answerWidth / typographyScale, 96);
  const requestWidth = Math.max(
    240,
    Math.min(estimateRequestMaxWidth(options.interfaceScale), availableWidth * 0.8),
  );
  const requestColumns = estimatedTextColumns((requestWidth - 28) / typographyScale, 86);

  const estimatedRequestContent = shouldCollapseUserRequest(
    turn.userMessage.content,
  )
    ? collapsedUserRequestPreview(turn.userMessage.content)
    : turn.userMessage.content;
  const requestLines = Math.max(
    1,
    estimatedWrappedLines(estimatedRequestContent, requestColumns),
  );
  const attachmentRows = Math.ceil(turn.userMessage.attachments.length / Math.max(1, Math.floor(requestWidth / 180)));
  const requestActionsHeight = turn.userMessage.privateConnectDeviceId
    || turn.userMessage.watcherNote
    || turn.checkpoint
    || turn.checkpointUnavailableReason !== null
    ? 28
    : 0;
  const requestHeight = turn.watcherWake ? WATCHER_WAKE_REQUEST_HEIGHT : turn.userMessage.duoComparison ? DUO_COMPARISON_REQUEST_HEIGHT : (24
    + USER_REQUEST_META_HEIGHT
    + requestActionsHeight
    + requestLines * 22
    + attachmentRows * 25
    + (estimatedRequestContent === turn.userMessage.content ? 0 : 28));

  const transcriptActivities = turn.activities.filter(isTranscriptActivity);
  const activeActivityGroups = turn.isActive
    ? buildTurnExecutionStream(turn)
      .filter((entry): entry is Extract<TurnExecutionStreamEntry, { kind: "activity-group" }> =>
        entry.kind === "activity-group")
    : [];
  const collapsedActivityHeight = activeActivityGroups.reduce((total, entry, index) =>
    total + estimateActivityGroupHeight(
      entry.activities,
      options.activityGroupsExpanded === true,
      index === activeActivityGroups.length - 1,
    ), 0);
  const activeCommentaryHeight = turn.commentaryMessages.reduce((total, message) =>
    total + 12 + estimatedWrappedLines(message.content, answerColumns) * 18, 0);
  const activeFollowUpHeight = turn.followUpMessages.reduce((total, message) =>
    total + 14 + estimatedWrappedLines(message.content, answerColumns - 6) * 18, 0);
  const includesReasoning = options.showThinking !== false && Boolean(turn.reasoning);
  const hasSupplementalWork = turn.plans.length > 0 || includesReasoning;
  const importantHeight = estimateActivityGroupHeight(
    turn.importantActivities.filter((activity) =>
      activity.kind !== "error" || activity.status !== "failed"),
    false,
  ) + (
    turn.agentTurn.status === "failed"
    && turn.importantActivities.length > 1
    && latestFailureIndex(turn.importantActivities) >= 0
      ? 28
      : 0
  );
  const foldsTurn = !turn.isActive && shouldFoldSettledTurn(turn);
  const foldVisible = foldsTurn && (
    options.settledSubagentsFoldable === true
    || turnHasFoldableWork(turn, { showThinking: options.showThinking !== false })
  );
  const consolidatesSettledWork = isQuietSettledTurn(turn, foldVisible);
  const failureActivities = turn.importantActivities.filter((activity) =>
    activity.kind === "error" && activity.status === "failed");
  const settledFailureFolded = !turn.isActive
    && !options.workDetailsExpanded
    && (turn.agentTurn.status === "failed" || failureActivities.length > 0);
  const openFailureHeight = turn.isActive || settledFailureFolded
    ? 0
    : failureActivities.reduce((total, activity) =>
      total + estimateFailurePanelHeight(activity, availableWidth), 0);
  let settledExchangeHeight = 0;
  if (!turn.isActive) {
    settledExchangeHeight = activeFollowUpHeight;
    for (const answer of followUpAnswers(turn)) {
      settledExchangeHeight += 18 + estimateMarkdownHeight(answer.content, answerColumns);
    }
  }
  const executionHeight = turn.isActive
    ? 43
      + activeCommentaryHeight
      + activeFollowUpHeight
      + collapsedActivityHeight
      + (hasSupplementalWork ? 27 : 0)
    : consolidatesSettledWork
      ? 0
      : foldsTurn
        ? (foldVisible || needsStaticFoldRow(turn, foldVisible) ? 32 : 0)
          + importantHeight
          + (failureActivities.length > 0 ? 28 + (settledFailureFolded ? 0 : openFailureHeight) : 0)
          + settledExchangeHeight
        : 32
          + (settledFailureFolded ? 0 : importantHeight + openFailureHeight)
          + settledExchangeHeight;
  const workExpanded = foldsTurn
    ? foldVisible && options.turnFoldExpanded === true
    : options.workDetailsExpanded === true;
  const expandedWorkHeight = workExpanded
    && (transcriptActivities.length > 0
      || turn.commentaryMessages.length > 0
      || hasSupplementalWork)
    ? estimateExpandedWorkHeight(
        turn,
        answerColumns,
        includesReasoning,
        options.activityGroupsExpanded === true,
      )
    : 0;
  const foldedSubagentsHeight = workExpanded && options.settledSubagentsFoldable === true
    ? SUBAGENT_GROUP_ROW_HEIGHT
    : 0;
  const exceptionalHeight = turn.approvals.reduce((total, approval) =>
    total + estimateApprovalHeight(approval, answerColumns), 0)
    + turn.inputRequests.reduce((total, request) =>
      total + estimateInputRequestHeight(request, answerColumns), 0);

  const systemHeight = turn.systemMessages.reduce((total, message) =>
    total + 35 + estimatedWrappedLines(message.content, answerColumns) * 20, 0);
  // Frames are sized in CSS pixels, so they stay outside the typography scale.
  const htmlRenderHeight = turn.htmlRenders.reduce((total, message, index) =>
    total + (message.htmlRender?.height ?? 0) + (index > 0 ? 12 : 0), 0);
  const answerContent = turn.terminalAssistantMessage?.content ?? "";
  const answerHeight = answerContent
    ? (turn.providerChanged ? 26 : 0) + estimateMarkdownHeight(answerContent, answerColumns)
    : 0;
  const metadataHeight = turn.terminalAssistantMessage
    || (!turn.isActive && turn.agentTurn.status !== "completed")
    ? 33 + (options.runDetailsExpanded
      ? 34 + (turn.gitArtifact && isTurnGitArtifactWithoutChanges(turn.gitArtifact) ? 28 : 0)
      : 0)
    : 0;

  const artifact = turn.gitArtifact;
  const visibleArtifact = options.showChangedFiles !== false
    && artifact !== null
    && shouldShowTurnGitArtifactSummary(artifact)
    ? artifact
    : null;
  const changedFilesHeight = visibleArtifact
    ? visibleArtifact.status === "unavailable"
      || visibleArtifact.status === "failed"
      || visibleArtifact.completeness === "unavailable"
      ? 32 + Math.max(
          18,
          estimatedWrappedLines(
            visibleArtifact.failureReason
              ?? "No authoritative Git snapshot was captured for this turn.",
            answerColumns,
          ) * 18,
        )
      : 29 + (options.changedFilesExpanded
        ? Math.min(12, visibleArtifact.files.length) * 28
          + (visibleArtifact.completeness === "complete" ? 0 : 35)
          + 38
        : 0)
    : 0;
  const executionSectionHeight = executionHeight
    + expandedWorkHeight
    + foldedSubagentsHeight
    + exceptionalHeight
    + systemHeight;
  const orderedSections = [
    { kind: "request", height: requestHeight },
    { kind: "execution", height: executionSectionHeight },
    { kind: "html-renders", height: htmlRenderHeight },
    { kind: "answer", height: answerHeight },
    { kind: "metadata", height: metadataHeight },
    { kind: "artifact", height: changedFilesHeight },
  ].filter(({ height }) => height > 0);
  const settledSpacing = estimateCompletedTurnSpacing(options.responseDensity);
  const sectionSpacing = orderedSections.slice(1).reduce((total, section, index) => {
    const previous = orderedSections[index]!;
    if (turn.isActive) {
      return total + estimateResponseBlockGap(options.responseDensity);
    }
    if (previous.kind === "answer" && section.kind === "metadata") {
      return total + settledSpacing.footer;
    }
    if (previous.kind === "metadata" && section.kind === "artifact") {
      return total + settledSpacing.artifact;
    }
    return total + settledSpacing.layer;
  }, 0);
  const virtualRowGap = estimateTurnGap(options.responseDensity);

  const contentHeight = requestHeight
    + executionHeight
    + expandedWorkHeight
    + foldedSubagentsHeight
    + exceptionalHeight
    + systemHeight
    + answerHeight
    + metadataHeight
    + changedFilesHeight
    + sectionSpacing;
  return Math.max(
    Math.ceil((160 - 36) * typographyScale + virtualRowGap),
    Math.ceil(contentHeight * typographyScale + htmlRenderHeight + virtualRowGap),
  );
}

export function estimateTimelineRowSize(
  item: ResponseTimelineItem,
  options: TimelineRowEstimateOptions = {},
): number {
  if (item.kind === "compaction") {
    return item.message.compaction?.trigger === "on-return"
      ? 56
      : 120 + Math.ceil(item.message.content.length / 80) * 20;
  }
  if (item.kind === "handoff") return 64;
  if (item.kind === "watcher-note") return WATCHER_NOTE_ROW_HEIGHT;
  if (item.kind === "compatibility") {
    const availableWidth = boundedEstimateWidth(options.availableWidth);
    const columns = estimatedTextColumns(Math.min(760, availableWidth - 40), 96);
    const inferredHeight = item.compatibility.inferredTurns.reduce((total, turn) =>
      total + estimateTurnRowSize(turn, options), 0);
    const messageHeight = item.compatibility.messages.reduce((total, message) =>
      total + 30 + estimatedWrappedLines(message.content, columns) * 20, 0);
    const recordHeight = (
      item.compatibility.malformedTurns.length
      + item.compatibility.activities.length
      + item.compatibility.reasonings.length
      + item.compatibility.plans.length
      + item.compatibility.checkpoints.length
    ) * 30;
    return Math.max(240, Math.ceil(Math.min(12_000, 100 + inferredHeight + messageHeight + recordHeight)));
  }
  const turn = item.turn;
  return estimateTurnRowSize(turn, options);
}

export interface TimelineMinimapMarker {
  index: number;
  id: string;
  label: string;
  summary: string | null;
}

export function buildTimelineMinimapMarkers(
  turns: ResponseTurn[],
  maximum = TIMELINE_MINIMAP_MAX_MARKERS,
): TimelineMinimapMarker[] {
  if (turns.length === 0 || maximum <= 0) return [];
  const count = Math.min(turns.length, Math.floor(maximum));
  return Array.from({ length: count }, (_, marker) => {
    const index = Math.round(marker * (turns.length - 1) / Math.max(1, count - 1));
    const turn = turns[index]!;
    const request = turn.watcherWake
      ? watcherCheckTitle(turn.watcherWake)
      : turn.userMessage.duoComparison
        ? DUO_COMPARISON_REQUEST_LABEL
        : turn.userMessage.content.replace(/\s+/gu, " ").trim();
    return {
      index,
      id: turn.id,
      label: request.length > 120 ? `${request.slice(0, 119)}…` : request || `Turn ${turn.index}`,
      summary: turn.terminalAssistantMessage?.content.slice(0, 180) ?? null,
    };
  });
}

export interface TimelineKeyboardIntent {
  index: number;
  target: "turn" | "request" | "final" | "artifact";
}

export function resolveTimelineKeyboardIntent(
  event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
  currentIndex: number,
  rowCount: number,
): TimelineKeyboardIntent | null {
  if (
    rowCount <= 0
    || !event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
  ) return null;
  const current = Math.max(0, Math.min(currentIndex, rowCount - 1));
  if (event.key === "ArrowUp") return { index: Math.max(0, current - 1), target: "turn" };
  if (event.key === "ArrowDown") return { index: Math.min(rowCount - 1, current + 1), target: "turn" };
  if (event.key === "Home") return { index: current, target: "request" };
  if (event.key === "End") return { index: current, target: "final" };
  if (event.key.toLowerCase() === "g") return { index: current, target: "artifact" };
  return null;
}

const READER_AT_LATEST_THRESHOLD = 2;
const READER_LIVE_REJOIN_THRESHOLD = 32;

export function readerScrollReachesLatest(input: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  previousScrollTop: number | null;
  live: boolean;
  aimedAtLatest?: boolean;
}): boolean {
  const movedUp = input.previousScrollTop !== null && input.scrollTop < input.previousScrollTop;
  if (input.aimedAtLatest && !movedUp) return true;
  return shouldFollowTimeline(
    input.scrollTop,
    input.clientHeight,
    input.scrollHeight,
    input.live && !movedUp ? READER_LIVE_REJOIN_THRESHOLD : READER_AT_LATEST_THRESHOLD,
  );
}

export function readerScrollFollow(input: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  previousScrollTop: number | null;
  live: boolean;
  intentional: boolean;
  aimedAtLatest: boolean;
}): { follows: boolean; arrived: boolean } {
  const arrived = input.intentional
    ? readerScrollReachesLatest({ ...input, aimedAtLatest: false })
    : shouldFollowTimeline(input.scrollTop, input.clientHeight, input.scrollHeight);
  return {
    arrived,
    follows: arrived || (input.intentional && input.aimedAtLatest && readerScrollReachesLatest(input)),
  };
}

export function shouldFollowTimeline(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 120): boolean {
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) return true;
  return Math.max(0, scrollHeight - clientHeight - scrollTop) <= threshold;
}

export interface TimelineSizeChangeAnchor {
  itemStart: number;
  itemSize: number;
  scrollOffset: number;
  firstMeasurement: boolean;
  scrollDirection: "forward" | "backward" | null;
  manuallyAnchored: boolean;
}

/**
 * Mirrors the virtualizer's stable-scroll policy while allowing an explicit
 * disclosure anchor to own one row's compensation. First measurements above
 * the fold correct estimate error. Later growth only shifts the viewport when
 * the entire row is above it; a streaming row spanning the fold and backward
 * user scrolling must remain stationary.
 */
export function shouldAdjustTimelineScrollPosition(
  input: TimelineSizeChangeAnchor,
): boolean {
  if (input.manuallyAnchored) return false;
  if (input.firstMeasurement) return input.itemStart < input.scrollOffset;
  return input.itemStart + input.itemSize <= input.scrollOffset
    && input.scrollDirection !== "backward";
}
