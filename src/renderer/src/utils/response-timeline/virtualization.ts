import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  InterfaceScale,
  ResponseDensity,
} from "@shared/contracts";
import {
  activityDetailPresentation,
  buildTurnExecutionStream,
  isTranscriptActivity,
  MAX_ACTIVITY_DETAIL_PREVIEW_LINES,
  resolveActivityGroupPresentation,
  type TurnExecutionStreamEntry,
} from "./execution";
import {
  shouldConsolidateSettledWorkIntoRunDetails,
  type ResponseTimelineItem,
  type ResponseTurn,
  type TurnGitArtifactSummary,
} from "./model";
import {
  collapsedUserRequestPreview,
  shouldCollapseUserRequest,
} from "../userRequestPresentation";

export const TIMELINE_VIRTUALIZATION_MIN_ROWS = 40;
export const TIMELINE_MINIMAP_MIN_GUTTER = 48;
export const TIMELINE_MINIMAP_MAX_MARKERS = 48;

export function shouldVirtualizeTimeline(rowCount: number): boolean {
  return Number.isFinite(rowCount) && rowCount >= TIMELINE_VIRTUALIZATION_MIN_ROWS;
}

export function shouldShowTimelineMinimap(rowCount: number, sideGutter: number): boolean {
  return shouldVirtualizeTimeline(rowCount)
    && Number.isFinite(sideGutter)
    && sideGutter >= TIMELINE_MINIMAP_MIN_GUTTER;
}

export function shouldShowTurnGitArtifactSummary(
  artifact: TurnGitArtifactSummary,
): boolean {
  return !(
    artifact.status === "unavailable"
    && artifact.completeness === "unavailable"
    && artifact.absenceReason === "not-repository"
  );
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
  if (scale === "compact") return 720;
  if (scale === "comfortable" || scale === "large") return 780;
  return 760;
}

function estimateRequestMaxWidth(scale: InterfaceScale | undefined): number {
  if (scale === "compact") return 640;
  if (scale === "comfortable") return 700;
  if (scale === "large") return 720;
  return 680;
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
  for (const character of value) {
    if (character === "\t") {
      columns += 4;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    columns += codePoint > 0x2e7f ? 2 : 1;
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
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const lines = estimatedWrappedLines(paragraph.join(" "), columns);
    blocks.push(Math.max(25, lines * 25));
    paragraph.length = 0;
  };
  const flushCode = (): void => {
    if (codeLines === 0) return;
    blocks.push(Math.min(4_800, 18 + codeLines * 20));
    codeLines = 0;
  };

  for (const rawLine of content.replace(/\r/gu, "").split("\n")) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) {
      flushParagraph();
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
      continue;
    }
    if (/^#{1,6}\s/u.test(trimmed)) {
      flushParagraph();
      blocks.push(Math.max(30, estimatedWrappedLines(trimmed.replace(/^#{1,6}\s+/u, ""), columns) * 30));
      continue;
    }
    if (/^(?:[-+*]|\d+[.)])\s/u.test(trimmed)) {
      flushParagraph();
      blocks.push(Math.max(25, estimatedWrappedLines(trimmed.replace(/^(?:[-+*]|\d+[.)])\s+/u, ""), columns - 4) * 25));
      continue;
    }
    if (trimmed.startsWith(">")) {
      flushParagraph();
      blocks.push(18 + estimatedWrappedLines(trimmed.replace(/^>\s?/u, ""), columns - 4) * 25);
      continue;
    }
    if (/^\|.*\|$/u.test(trimmed)) {
      flushParagraph();
      blocks.push(Math.max(28, estimatedWrappedLines(trimmed, columns) * 28));
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
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
): number {
  const presentation = resolveActivityGroupPresentation(activities, expanded);
  const detailHeight = presentation.visibleActivities.reduce((total, activity) => {
    const detail = activityDetailPresentation(activity);
    if (!detail.expandable || !detail.preview) return total;
    const previewLines = Math.min(
      MAX_ACTIVITY_DETAIL_PREVIEW_LINES,
      detail.preview.split("\n").length,
    );
    return total + previewLines * 18 + 23;
  }, 0);
  return presentation.visibleActivities.length * 27
    + (presentation.hiddenCount > 0 ? 23 : 0)
    + detailHeight;
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
          return total + 27 + estimatedWrappedLines(entry.message.content, columns - 6) * 18;
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

function estimateRunDetailsHeight(
  turn: ResponseTurn,
  availableWidth: number,
): number {
  const artifactDetailVisible = turn.gitArtifact === null
    || shouldShowTurnGitArtifactSummary(turn.gitArtifact);
  const detailCount = 11 + Number(artifactDetailVisible);
  if (availableWidth <= 440) {
    return 8 + detailCount * 38 + Math.max(0, detailCount - 1) * 8;
  }
  if (availableWidth <= 620) {
    return 8 + detailCount * 18 + Math.max(0, detailCount - 1) * 8;
  }
  const rows = Math.ceil(detailCount / 2);
  return 8 + rows * 18 + Math.max(0, rows - 1) * 8;
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
  const requestHeight = 42
    + requestLines * 22
    + attachmentRows * 25
    + (estimatedRequestContent === turn.userMessage.content ? 0 : 28);

  const transcriptActivities = turn.activities.filter(isTranscriptActivity);
  const activeActivityGroups = turn.isActive
    ? buildTurnExecutionStream(turn)
      .filter((entry): entry is Extract<TurnExecutionStreamEntry, { kind: "activity-group" }> =>
        entry.kind === "activity-group")
    : [];
  const collapsedActivityHeight = activeActivityGroups.reduce((total, entry) =>
    total + estimateActivityGroupHeight(
      entry.activities,
      options.activityGroupsExpanded === true,
    ), 0);
  const activeCommentaryHeight = turn.commentaryMessages.reduce((total, message) =>
    total + 12 + estimatedWrappedLines(message.content, answerColumns) * 18, 0);
  const activeFollowUpHeight = turn.followUpMessages.reduce((total, message) =>
    total + 27 + estimatedWrappedLines(message.content, answerColumns - 6) * 18, 0);
  const includesReasoning = options.showThinking !== false && Boolean(turn.reasoning);
  const hasSupplementalWork = turn.plans.length > 0 || includesReasoning;
  // Attention rows use the same bounded preview/disclosure geometry as their
  // rendered ActivityRow instead of a generic status-row approximation.
  const importantHeight = turn.importantActivities.reduce((total, activity) =>
    total + estimateActivityGroupHeight([activity], true), 0);
  const consolidatesSettledWork = shouldConsolidateSettledWorkIntoRunDetails(turn);
  const executionHeight = turn.isActive
    ? 43
      + activeCommentaryHeight
      + activeFollowUpHeight
      + collapsedActivityHeight
      + (hasSupplementalWork ? 27 : 0)
    : consolidatesSettledWork
      ? 0
      : 30 + importantHeight;
  const expandedWorkHeight = (
    options.workDetailsExpanded
      || (consolidatesSettledWork && options.runDetailsExpanded)
  )
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
  const exceptionalHeight = turn.approvals.reduce((total, approval) =>
    total + estimateApprovalHeight(approval, answerColumns), 0)
    + turn.inputRequests.reduce((total, request) =>
      total + estimateInputRequestHeight(request, answerColumns), 0);

  const systemHeight = turn.systemMessages.reduce((total, message) =>
    total + 35 + estimatedWrappedLines(message.content, answerColumns) * 20, 0);
  const answerContent = turn.terminalAssistantMessage?.content ?? "";
  const answerHeight = answerContent
    ? 26 + estimateMarkdownHeight(answerContent, answerColumns)
    : 0;
  const metadataHeight = turn.terminalAssistantMessage
    ? 37 + (options.runDetailsExpanded
      ? estimateRunDetailsHeight(turn, availableWidth)
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
      : 33 + (options.changedFilesExpanded
        ? Math.min(12, visibleArtifact.files.length) * 28
          + (visibleArtifact.completeness === "complete" ? 0 : 35)
          + 38
        : 0)
    : 0;
  const consolidatedWorkHeight = consolidatesSettledWork
    ? expandedWorkHeight
    : 0;
  const executionSectionHeight = executionHeight
    + (consolidatesSettledWork ? 0 : expandedWorkHeight)
    + exceptionalHeight
    + systemHeight;
  const orderedSections = [
    { kind: "request", height: requestHeight },
    { kind: "execution", height: executionSectionHeight },
    { kind: "answer", height: answerHeight },
    {
      kind: "metadata",
      height: metadataHeight + consolidatedWorkHeight,
    },
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
    + exceptionalHeight
    + systemHeight
    + answerHeight
    + metadataHeight
    + changedFilesHeight
    + sectionSpacing;
  return Math.max(
    Math.ceil((190 - 36) * typographyScale + virtualRowGap),
    Math.ceil(contentHeight * typographyScale + virtualRowGap),
  );
}

export function estimateTimelineRowSize(
  item: ResponseTimelineItem,
  options: TimelineRowEstimateOptions = {},
): number {
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
}

export function buildTimelineMinimapMarkers(
  turns: ResponseTurn[],
  maximum = TIMELINE_MINIMAP_MAX_MARKERS,
): TimelineMinimapMarker[] {
  if (turns.length === 0 || maximum <= 0) return [];
  const count = Math.min(turns.length, Math.max(2, Math.floor(maximum)));
  const indexes = new Set<number>();
  for (let marker = 0; marker < count; marker += 1) {
    indexes.add(Math.round(marker * (turns.length - 1) / Math.max(1, count - 1)));
  }
  return [...indexes].map((index) => {
    const turn = turns[index]!;
    const request = turn.userMessage.content.replace(/\s+/gu, " ").trim();
    return {
      index,
      id: turn.id,
      label: request.length > 72 ? `${request.slice(0, 69)}…` : request || `Turn ${turn.index}`,
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
