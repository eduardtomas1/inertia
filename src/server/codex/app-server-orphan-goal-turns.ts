import { stableProviderActivityId } from "../provider/activity-lifecycle";
import type { CodexRunPhase } from "./app-server-config";
import type { CodexRequestFailureRecording } from "./app-server-request-errors";
import type { JsonObject } from "./protocol";
import type { CodexAppServerOptions } from "./types";

type Request = (
  method: string,
  params: JsonObject,
  onResponseFrame?: (result?: JsonObject) => void,
  recordFailure?: CodexRequestFailureRecording,
) => Promise<JsonObject>;

interface GoalProjection {
  beginGoalMutation: (activatesGoal: boolean) => void;
  endGoalMutation: (activatesGoal: boolean) => void;
  goalProjectionSequence: () => number;
  projectGoalResponse: (threadId: string, goal: unknown, sequenceAtResponse: number) => { status: string } | null;
}

/** What the run's event projection tells the tracker. */
export interface CodexOrphanGoalTurnContext {
  phase: () => CodexRunPhase;
  goalActive: () => boolean;
  completedTurnIds: Set<string>;
  emitActivity: (label: string, activityId: string) => void;
}

const STOPPED_LABEL = "Stopped the turn Codex continued the goal with on resume";
const FINISHED_LABEL = "Codex continued the goal on resume; that turn ended before this run's turn and is not shown";
const PAUSED_LABEL = "Paused the goal Codex continued on resume";
const PAUSE_FAILED_LABEL = "Could not pause the goal Codex continued on resume; it stays active";

/**
 * How long a run that did not ask for the goal waits, after thread/resume
 * answers, for Codex to continue an active goal before it sends its own
 * turn/start. Codex starts that turn from the resume handler right after the
 * response (T3 CodexAdapterV2 ~8143), so its turn/started follows within a
 * few milliseconds over the local pipe; 250 ms leaves room for a loaded
 * machine while adding at most a quarter second, and only when a goal is
 * active. A turn that starts later is steered into, as in T3.
 */
export const CODEX_GOAL_CONTINUATION_START_GRACE_MS = 250;

/** A resumed thread whose active goal Codex may continue on its own, in a run that did not ask for the goal. */
export function codexGoalMayContinue(
  options: Pick<CodexAppServerOptions, "sessionId" | "goalContinuationExpected" | "goalStart">,
): boolean {
  return options.sessionId !== undefined && options.goalContinuationExpected === true && !options.goalStart;
}

/**
 * Goal turns Codex starts on a resumed thread that no run owns (T3
 * 47583f868, CodexAdapterV2 ~5247): the goal is paused, the turn interrupted
 * and none of its output projected. Inertia sends the run's turn/start in the
 * same flow, and Codex steers a turn/start on a busy thread into the running
 * turn, so the run waits, bounded, for the stopped turn's turn/completed
 * first. A run that asked for the goal (`goalStart`) owns the turn instead.
 */
export class CodexOrphanGoalTurns {
  private context: CodexOrphanGoalTurnContext | undefined;
  private orphanTurnId: string | undefined;
  private readonly stoppedTurnIds = new Set<string>();
  private paused = false;
  private orphanStarted: (() => void) | undefined;
  private waiting: { turnId: string; stopped: Promise<void>; settle: (error?: Error) => void } | undefined;

  constructor(
    private readonly options: Pick<CodexAppServerOptions, "goalStart">,
    private readonly threadId: () => string | undefined,
    private readonly request: Request,
    private readonly goals: () => GoalProjection,
    private readonly timeoutMs: number,
  ) {}

  attach(context: CodexOrphanGoalTurnContext): void {
    this.context = context;
  }

  /** Takes every update of an orphan goal turn; true when the projection must not see it. */
  observe(method: string, threadId: string | undefined, turnId: string | undefined): boolean {
    const context = this.context;
    if (!context || !threadId || !turnId || threadId !== this.threadId()) return false;
    if (turnId === this.orphanTurnId) {
      if (method === "turn/completed") {
        context.completedTurnIds.add(turnId);
        if (this.waiting?.turnId === turnId) this.waiting.settle();
      }
      return true;
    }
    if (
      method !== "turn/started" || context.phase() !== "opening" || this.options.goalStart
      || this.orphanTurnId !== undefined || context.completedTurnIds.has(turnId) || !context.goalActive()
    ) return false;
    this.orphanTurnId = turnId;
    this.stoppedTurnIds.add(turnId);
    this.waiting = this.wait(turnId);
    this.orphanStarted?.();
    context.emitActivity(STOPPED_LABEL, stableProviderActivityId("codex-orphan-goal-turn", threadId, turnId));
    this.stop(threadId, turnId, true);
    return true;
  }

  isStopped(turnId: string): boolean {
    return this.stoppedTurnIds.has(turnId);
  }

  /**
   * turn/start's response named the run's own turn, so a turn Codex started
   * meanwhile and that was held was never the run's: its goal is paused
   * rather than left running unseen.
   */
  discarded(turns: ReadonlyArray<{ turnId: string; completed: boolean }>): void {
    // Their held approvals are answered with a cancel, as an orphan's are.
    for (const { turnId } of turns) this.stoppedTurnIds.add(turnId);
    const context = this.context;
    const threadId = this.threadId();
    if (!context || !threadId || this.options.goalStart || !context.goalActive()) return;
    for (const { turnId, completed } of turns) {
      if (completed) context.completedTurnIds.add(turnId);
      context.emitActivity(completed ? FINISHED_LABEL : STOPPED_LABEL,
        stableProviderActivityId("codex-orphan-goal-turn", threadId, turnId));
      this.stop(threadId, turnId, !completed);
    }
  }

  /**
   * Before the run's own turn/start: where Codex may continue the goal, gives
   * it the start grace to do so, then waits for a stopped goal turn's
   * turn/completed. Rejects when Codex does not stop it in time.
   */
  async awaitStopped(goalMayContinue: boolean, graceMs = CODEX_GOAL_CONTINUATION_START_GRACE_MS): Promise<void> {
    if (goalMayContinue && !this.waiting) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        this.orphanStarted = () => { clearTimeout(timer); resolve(); };
      });
      this.orphanStarted = undefined;
    }
    await this.waiting?.stopped;
  }

  /** The run ended; nothing waits for the stopped turn any more. */
  release(): void {
    this.orphanStarted?.();
    this.waiting?.settle();
  }

  /** Says "paused" only once Codex confirms it; a failed pause leaves the goal shown as active. */
  private async pause(threadId: string): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    const goals = this.goals();
    goals.beginGoalMutation(false);
    let paused = false;
    try {
      let sequenceAtResponse = goals.goalProjectionSequence();
      const response = await this.request("thread/goal/set", { threadId, status: "paused" }, () => {
        sequenceAtResponse = goals.goalProjectionSequence();
      }, false);
      paused = goals.projectGoalResponse(threadId, response.goal, sequenceAtResponse)?.status === "paused";
    } catch {
      // As in T3, a failed pause still stops the turn; a later orphan tries again.
    } finally {
      goals.endGoalMutation(false);
    }
    if (!paused) this.paused = false;
    this.context?.emitActivity(paused ? PAUSED_LABEL : PAUSE_FAILED_LABEL,
      stableProviderActivityId("codex-orphan-goal-pause", threadId, paused ? "paused" : `failed:${Date.now()}`));
  }

  private stop(threadId: string, turnId: string, interrupt: boolean): void {
    // T3's order on the wire: pause, then interrupt. The interrupt does not wait for the pause's response, so a
    // slow pause cannot spend the stop's time budget.
    void this.pause(threadId);
    if (!interrupt) return;
    // An error, such as "no active turn" from a turn that is finishing, still waits for its turn/completed until
    // the time budget runs out.
    void this.request("turn/interrupt", { threadId, turnId }, undefined, false).catch(() => undefined);
  }

  private wait(turnId: string): NonNullable<CodexOrphanGoalTurns["waiting"]> {
    let settleStopped!: (error?: Error) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      settleStopped = (error) => error ? reject(error) : resolve();
    });
    stopped.catch(() => undefined);
    const timer = setTimeout(() => settleStopped(
      new Error("Codex did not stop the goal turn it continued when the thread resumed."),
    ), this.timeoutMs);
    timer.unref();
    return { turnId, stopped, settle: (error) => { clearTimeout(timer); settleStopped(error); } };
  }
}
