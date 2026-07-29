import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import type {
  AgentGoal,
  AgentGoalSource,
  AgentGoalStatus,
  AgentSkillScope,
  AgentSkillSummary,
  AgentWorkflowState,
  Conversation,
  ProviderSkillInput,
} from "../../shared/contracts";
import { withCodexControlClient } from "../codex/control-client";
import { objectValue, type JsonObject } from "../codex/protocol";
import type { RuntimeStore } from "../database";
import { normalizeIdentityPath } from "../project-identity";
import type { ProviderManager } from "../providers";
import { RuntimeRequestError } from "../runtime-errors";

const MAX_SKILLS = 128;
const SKILL_CAPABILITY_TTL_MS = 30 * 60 * 1_000;
const CODEX_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

interface PrivateSkillCapability {
  summary: AgentSkillSummary;
  providerInput: ProviderSkillInput;
  identityKey: string;
  routeKey: string;
  expiresAt: number;
}

interface SkillDiscoveryState {
  truncated: boolean;
  warningCount: number;
  synchronizedAt: string | null;
}

interface RouteBoundSkillDiscoveryState {
  routeKey: string;
  state: SkillDiscoveryState;
}

interface SkillDiscoveryFlight {
  forceReload: boolean;
  routeKey: string;
  promise: Promise<AgentSkillSummary[]>;
}

const EMPTY_SKILL_DISCOVERY: SkillDiscoveryState = {
  truncated: false,
  warningCount: 0,
  synchronizedAt: null,
};

function exactBoundedString(
  value: unknown,
  maximum: number,
): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.includes("\0")
  ) return undefined;
  return value;
}

function boundedDisplayString(
  value: unknown,
  maximum: number,
): string | undefined {
  const exact = exactBoundedString(value, maximum);
  const clean = exact?.trim();
  return clean || undefined;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) return null;
  return value;
}

function isoFromUnixSeconds(value: unknown): string | null {
  const seconds = boundedInteger(value, 0, 32_503_680_000);
  if (seconds === null) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function goalStatus(value: unknown): AgentGoalStatus | null {
  return value === "active"
    || value === "paused"
    || value === "blocked"
    || value === "usageLimited"
    || value === "budgetLimited"
    || value === "complete"
    ? value
    : null;
}

export function parseCodexGoal(
  conversationId: string,
  expectedSessionId: string,
  value: unknown,
  synchronizedAt = new Date().toISOString(),
): AgentGoal | null {
  const goal = objectValue(value);
  const providerSessionId = exactBoundedString(goal?.threadId, 512);
  const objective = boundedDisplayString(goal?.objective, 4_000);
  const status = goalStatus(goal?.status);
  const tokensUsed = boundedInteger(
    goal?.tokensUsed,
    0,
    1_000_000_000_000,
  );
  const timeUsedSeconds = boundedInteger(
    goal?.timeUsedSeconds,
    0,
    315_360_000,
  );
  const createdAt = isoFromUnixSeconds(goal?.createdAt);
  const updatedAt = isoFromUnixSeconds(goal?.updatedAt);
  const hasTokenBudget = goal?.tokenBudget !== undefined
    && goal.tokenBudget !== null;
  const tokenBudget = hasTokenBudget
    ? boundedInteger(goal?.tokenBudget, 1, 1_000_000_000)
    : null;
  if (
    providerSessionId !== expectedSessionId
    || !objective
    || !status
    || tokensUsed === null
    || timeUsedSeconds === null
    || !createdAt
    || !updatedAt
    || (hasTokenBudget && tokenBudget === null)
  ) return null;
  return {
    conversationId,
    source: "codex-native",
    providerSessionId,
    objective,
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
    synchronizedAt,
  };
}

function skillScope(value: unknown): AgentSkillScope | null {
  return value === "user"
    || value === "repo"
    || value === "system"
    || value === "admin"
    ? value
    : null;
}

function isNativeCodexConversation(
  conversation: Conversation,
): boolean {
  return conversation.providerId === "codex"
    && conversation.modelSelection.harnessId === "codex-app-server";
}

function isNativeClaudeConversation(
  conversation: Conversation,
): boolean {
  return conversation.providerId === "claude"
    && conversation.modelSelection.harnessId === "claude-agent-sdk";
}

export class AgentWorkflowController {
  private readonly skills = new Map<string, PrivateSkillCapability>();
  private readonly skillIdsByPath = new Map<string, string>();
  private readonly skillDiscovery =
    new Map<string, RouteBoundSkillDiscoveryState>();
  private readonly nativeGoalOperations = new Map<string, Promise<void>>();
  private readonly skillDiscoveryFlights =
    new Map<string, SkillDiscoveryFlight>();

  constructor(
    private readonly store: RuntimeStore,
    private readonly providers: ProviderManager,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  state(conversationId: string): AgentWorkflowState {
    const conversation = this.store.conversation(conversationId);
    this.pruneSkills();
    const native = isNativeCodexConversation(conversation);
    const currentSkillRouteKey = this.skillRouteKey(
      conversation,
      this.store.conversationPath(conversationId),
    );
    const currentSkillDiscovery = this.skillDiscovery.get(conversationId);
    const goals = this.store.agentGoals(conversationId).filter((goal) => {
      if (goal.source === "inertia-local") return true;
      if (
        conversation.providerSessionId
        && goal.providerSessionId === conversation.providerSessionId
      ) return true;
      this.store.clearAgentGoal(conversationId, "codex-native");
      return false;
    });
    return {
      conversationId,
      goals,
      goalCapability: native && conversation.providerSessionId
        ? {
            kind: "codex-native",
            available: true,
            label: "Codex native goal",
          }
        : {
            kind: "inertia-local",
            available: true,
            label: "Inertia local goal",
            reason: native
              ? "Codex can own the goal after this chat starts a provider thread."
              : "This provider does not expose a native thread-goal API.",
          },
      skills: [...this.skills.values()]
        .filter(({ summary }) =>
          summary.conversationId === conversationId)
        .filter(({ routeKey }) => routeKey === currentSkillRouteKey)
        .map(({ summary }) => summary)
        .sort((left, right) =>
          left.scope.localeCompare(right.scope)
          || left.name.localeCompare(right.name)),
      skillsCapability: native
        ? {
            kind: "codex-native",
            available: true,
            label: "Codex skills",
          }
        : isNativeClaudeConversation(conversation)
          ? {
              kind: "claude-native",
              available: true,
              label: "Claude skills",
            }
        : {
            kind: "unavailable",
            available: false,
            label: "Skills unavailable",
            reason:
              "This route does not expose safe structured skill invocation.",
          },
      skillDiscovery: currentSkillDiscovery?.routeKey === currentSkillRouteKey
        ? currentSkillDiscovery.state
        : EMPTY_SKILL_DISCOVERY,
      refreshedAt: this.clock().toISOString(),
    };
  }

  async refresh(conversationId: string): Promise<AgentWorkflowState> {
    const conversation = this.store.conversation(conversationId);
    if (
      isNativeCodexConversation(conversation)
      && conversation.providerSessionId
    ) {
      const providerSessionId = conversation.providerSessionId;
      await this.withNativeGoalOperation(
        conversationId,
        providerSessionId,
        async () => {
          if (!this.hasNativeGoalSession(
            conversationId,
            providerSessionId,
          )) return;
          const observed = this.nativeGoal(
            conversationId,
            providerSessionId,
          );
          const context = await this.providers.codexControlContext(
            this.store.conversationPath(conversationId),
          );
          const response = await withCodexControlClient(
            context,
            ({ request }) => request("thread/goal/get", {
              threadId: providerSessionId,
            }),
          );
          if (!this.hasNativeGoalSession(
            conversationId,
            providerSessionId,
          )) return;
          if (response.goal === undefined) {
            throw new RuntimeRequestError(
              "Codex returned a malformed goal response.",
            );
          }
          const parsed = parseCodexGoal(
            conversationId,
            providerSessionId,
            response.goal,
            this.clock().toISOString(),
          );
          if (parsed) this.store.mergeNativeAgentGoal(parsed);
          else if (response.goal !== null) {
            throw new RuntimeRequestError(
              "Codex returned a malformed goal response.",
            );
          } else if (this.sameNativeGoalRevision(
            observed,
            this.nativeGoal(
              conversationId,
              providerSessionId,
            ),
          )) {
            this.store.clearAgentGoal(
              conversationId,
              "codex-native",
              this.clock().toISOString(),
              providerSessionId,
            );
          }
        },
      );
    }
    return this.state(conversationId);
  }

  async setGoal(input: {
    conversationId: string;
    source: AgentGoalSource;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }): Promise<AgentGoal> {
    const conversation = this.store.conversation(input.conversationId);
    const now = this.clock().toISOString();
    if (input.source === "inertia-local") {
      const existing = this.store.agentGoals(input.conversationId)
        .find(({ source }) => source === "inertia-local");
      const objective = input.objective?.trim() || existing?.objective;
      if (!objective) {
        throw new RuntimeRequestError(
          "Define an objective before creating a local goal.",
        );
      }
      return this.store.upsertAgentGoal({
        conversationId: input.conversationId,
        source: "inertia-local",
        providerSessionId: null,
        objective,
        status: input.status,
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: null,
        timeUsedSeconds: null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        synchronizedAt: null,
      });
    }
    this.requireNativeCodexGoal(conversation);
    const providerSessionId = conversation.providerSessionId!;
    return await this.withNativeGoalOperation(
      input.conversationId,
      providerSessionId,
      async () => {
        if (!this.hasNativeGoalSession(
          input.conversationId,
          providerSessionId,
        )) {
          throw new RuntimeRequestError(
            "The Codex thread changed before the goal could be updated.",
          );
        }
        const context = await this.providers.codexControlContext(
          this.store.conversationPath(input.conversationId),
        );
        const params: JsonObject = {
          threadId: providerSessionId,
          status: input.status,
        };
        if (input.objective !== undefined) params.objective = input.objective;
        if (input.tokenBudget !== undefined) {
          params.tokenBudget = input.tokenBudget;
        }
        const response = await withCodexControlClient(
          context,
          ({ request }) => request("thread/goal/set", params),
        );
        if (!this.hasNativeGoalSession(
          input.conversationId,
          providerSessionId,
        )) {
          throw new RuntimeRequestError(
            "The Codex thread changed before the goal could be updated.",
          );
        }
        const parsed = parseCodexGoal(
          input.conversationId,
          providerSessionId,
          response.goal,
          now,
        );
        if (!parsed) {
          throw new RuntimeRequestError(
            "Codex returned a malformed goal response.",
          );
        }
        const stored = this.store.mergeNativeAgentGoal(parsed, true).goal;
        if (!stored) {
          throw new RuntimeRequestError(
            "The Codex goal changed before the update could be stored.",
          );
        }
        return stored;
      },
    );
  }

  async clearGoal(
    conversationId: string,
    source: AgentGoalSource,
  ): Promise<boolean> {
    const conversation = this.store.conversation(conversationId);
    if (source === "codex-native") {
      this.requireNativeCodexGoal(conversation);
      const providerSessionId = conversation.providerSessionId!;
      return await this.withNativeGoalOperation(
        conversationId,
        providerSessionId,
        async () => {
          if (!this.hasNativeGoalSession(
            conversationId,
            providerSessionId,
          )) return false;
          const context = await this.providers.codexControlContext(
            this.store.conversationPath(conversationId),
          );
          await withCodexControlClient(
            context,
            ({ request }) => request("thread/goal/clear", {
              threadId: providerSessionId,
            }),
          );
          if (!this.hasNativeGoalSession(
            conversationId,
            providerSessionId,
          )) return false;
          return this.store.clearAgentGoal(
            conversationId,
            source,
            this.clock().toISOString(),
            providerSessionId,
          );
        },
      );
    }
    return this.store.clearAgentGoal(conversationId, source);
  }

  private hasNativeGoalSession(
    conversationId: string,
    providerSessionId: string,
  ): boolean {
    const current = this.store.conversation(conversationId);
    return isNativeCodexConversation(current)
      && current.providerSessionId === providerSessionId;
  }

  private nativeGoal(
    conversationId: string,
    providerSessionId: string,
  ): AgentGoal | null {
    return this.store.agentGoals(conversationId).find((goal) =>
      goal.source === "codex-native"
      && goal.providerSessionId === providerSessionId) ?? null;
  }

  private sameNativeGoalRevision(
    left: AgentGoal | null,
    right: AgentGoal | null,
  ): boolean {
    if (!left || !right) return left === right;
    return left.providerSessionId === right.providerSessionId
      && left.updatedAt === right.updatedAt
      && left.objective === right.objective
      && left.status === right.status
      && left.tokenBudget === right.tokenBudget
      && left.tokensUsed === right.tokensUsed
      && left.timeUsedSeconds === right.timeUsedSeconds;
  }

  private async withNativeGoalOperation<T>(
    conversationId: string,
    providerSessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${conversationId}\0${providerSessionId}`;
    const predecessor = this.nativeGoalOperations.get(key)
      ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => current);
    this.nativeGoalOperations.set(key, tail);
    await predecessor.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.nativeGoalOperations.get(key) === tail) {
        this.nativeGoalOperations.delete(key);
      }
    }
  }

  async listSkills(
    conversationId: string,
    forceReload: boolean,
  ): Promise<AgentSkillSummary[]> {
    const conversation = this.store.conversation(conversationId);
    const cwd = this.store.conversationPath(conversationId);
    if (
      !isNativeCodexConversation(conversation)
      && !isNativeClaudeConversation(conversation)
    ) {
      throw new RuntimeRequestError(
        "This route does not expose safe structured skill invocation.",
      );
    }
    const routeKey = this.skillRouteKey(conversation, cwd);
    const existing = this.skillDiscoveryFlights.get(conversationId);
    if (
      existing?.routeKey === routeKey
      && (existing.forceReload || !forceReload)
    ) return await existing.promise;
    const predecessor = existing?.promise ?? Promise.resolve([]);
    const promise = predecessor.catch(() => []).then(async () => {
      const current = this.store.conversation(conversationId);
      const currentCwd = this.store.conversationPath(conversationId);
      if (this.skillRouteKey(current, currentCwd) !== routeKey) {
        throw new RuntimeRequestError(
          "The provider route changed while skills were refreshing.",
        );
      }
      return await this.discoverSkills(
        conversationId,
        current,
        currentCwd,
        forceReload,
        routeKey,
      );
    });
    const flight: SkillDiscoveryFlight = {
      forceReload,
      routeKey,
      promise,
    };
    this.skillDiscoveryFlights.set(conversationId, flight);
    try {
      return await promise;
    } finally {
      if (this.skillDiscoveryFlights.get(conversationId) === flight) {
        this.skillDiscoveryFlights.delete(conversationId);
      }
    }
  }

  private async discoverSkills(
    conversationId: string,
    conversation: Conversation,
    cwd: string,
    forceReload: boolean,
    routeKey: string,
  ): Promise<AgentSkillSummary[]> {
    if (isNativeClaudeConversation(conversation)) {
      const rawSkills = await this.providers.claudeSkills(cwd, forceReload);
      this.requireCurrentSkillRoute(conversationId, routeKey);
      return this.replaceSkills(
        conversationId,
        rawSkills,
        rawSkills.length > MAX_SKILLS,
        0,
        (raw) => {
          const name = boundedDisplayString(raw.name, 160);
          const description = boundedDisplayString(raw.description, 1_000);
          if (!name || !description) return null;
          const identityKey =
            `${conversationId}\0${routeKey}\0claude\0${name}`;
          return {
            identityKey,
            summary: {
              id: this.skillIdsByPath.get(identityKey) ?? randomUUID(),
              conversationId,
              name,
              description,
              shortDescription:
                boundedDisplayString(raw.argumentHint, 240) ?? null,
              scope: "provider",
              enabled: true,
              source: "claude-native",
            },
            providerInput: {
              source: "claude-native",
              name,
            },
          };
        },
        routeKey,
      );
    }
    const context = await this.providers.codexControlContext(cwd);
    const response = await withCodexControlClient(
      context,
      ({ request }) => request("skills/list", {
        cwds: [cwd],
        forceReload,
      }),
    );
    this.requireCurrentSkillRoute(conversationId, routeKey);
    const entries = Array.isArray(response.data) ? response.data : [];
    const expectedCwd = normalizeIdentityPath(cwd);
    const matchingEntry = entries
      .map(objectValue)
      .find((entry) =>
        typeof entry?.cwd === "string"
        && normalizeIdentityPath(entry.cwd) === expectedCwd);
    if (!matchingEntry) {
      throw new RuntimeRequestError(
        "Codex did not return skills for this project.",
      );
    }
    if (
      Array.isArray(matchingEntry.errors)
      && matchingEntry.errors.length > 0
      && !Array.isArray(matchingEntry.skills)
    ) {
      throw new RuntimeRequestError(
        "Codex could not discover skills for this project.",
      );
    }
    const rawSkills = Array.isArray(matchingEntry?.skills)
      ? matchingEntry.skills
      : [];
    const warningCount = Array.isArray(matchingEntry.errors)
      ? matchingEntry.errors.length
      : 0;
    return this.replaceSkills(
      conversationId,
      rawSkills,
      rawSkills.length > MAX_SKILLS,
      warningCount,
      (raw) => {
        const skill = objectValue(raw);
        const name = boundedDisplayString(skill?.name, 160);
        const path = exactBoundedString(skill?.path, 4_096);
        const description = boundedDisplayString(skill?.description, 1_000);
        const scope = skillScope(skill?.scope);
        if (
          !name
          || !CODEX_SKILL_NAME_PATTERN.test(name)
          || !path
          || !isAbsolute(path)
          || !description
          || !scope
        ) return null;
        const identityKey =
          `${conversationId}\0${routeKey}\0codex\0${path}`;
        const interfaceValue = objectValue(skill?.interface);
        return {
          identityKey,
          summary: {
            id: this.skillIdsByPath.get(identityKey) ?? randomUUID(),
            conversationId,
            name,
            description,
            shortDescription:
              boundedDisplayString(
                interfaceValue?.shortDescription,
                240,
              ) ?? null,
            scope,
            enabled: skill?.enabled === true,
            source: "codex-native",
          },
          providerInput: {
            source: "codex-native",
            name,
            path,
          },
        };
      },
      routeKey,
    );
  }

  private skillRouteKey(conversation: Conversation, cwd: string): string {
    return [
      conversation.providerId,
      conversation.modelSelection.harnessId,
      conversation.modelSelection.backendProfileId,
      conversation.modelSelection.backendConfigurationRevision,
      normalizeIdentityPath(cwd),
    ].join("\0");
  }

  private requireCurrentSkillRoute(
    conversationId: string,
    expectedRouteKey: string,
  ): void {
    const conversation = this.store.conversation(conversationId);
    const cwd = this.store.conversationPath(conversationId);
    if (this.skillRouteKey(conversation, cwd) !== expectedRouteKey) {
      throw new RuntimeRequestError(
        "The provider route changed while skills were refreshing.",
      );
    }
  }

  async resolveSkills(
    conversationId: string,
    skillIds: readonly string[],
  ): Promise<ProviderSkillInput[]> {
    this.pruneSkills();
    const unique = [...new Set(skillIds)];
    if (unique.length > 8) {
      throw new RuntimeRequestError(
        "Select at most eight skills for one turn.",
      );
    }
    if (unique.length === 0) return [];
    await this.listSkills(conversationId, true);
    const conversation = this.store.conversation(conversationId);
    const routeKey = this.skillRouteKey(
      conversation,
      this.store.conversationPath(conversationId),
    );
    return unique.map((id) => {
      const capability = this.skills.get(id);
      if (
        !capability
        || capability.summary.conversationId !== conversationId
        || capability.routeKey !== routeKey
        || !capability.summary.enabled
      ) {
        throw new RuntimeRequestError(
          "A selected skill is no longer available. Refresh skills and try again.",
        );
      }
      return capability.providerInput;
    });
  }

  private replaceSkills<T>(
    conversationId: string,
    rawSkills: readonly T[],
    truncated: boolean,
    warningCount: number,
    mapSkill: (raw: T) => {
      identityKey: string;
      summary: AgentSkillSummary;
      providerInput: ProviderSkillInput;
    } | null,
    routeKey: string,
  ): AgentSkillSummary[] {
    const nextIds = new Set<string>();
    const summaries: AgentSkillSummary[] = [];
    const expiresAt = this.clock().getTime() + SKILL_CAPABILITY_TTL_MS;
    for (const raw of rawSkills.slice(0, MAX_SKILLS)) {
      const mapped = mapSkill(raw);
      if (!mapped) continue;
      const id = mapped.summary.id;
      this.skillIdsByPath.set(mapped.identityKey, id);
      nextIds.add(id);
      this.skills.set(id, {
        summary: mapped.summary,
        providerInput: mapped.providerInput,
        identityKey: mapped.identityKey,
        routeKey,
        expiresAt,
      });
      summaries.push(mapped.summary);
    }
    for (const [id, capability] of this.skills) {
      if (
        capability.summary.conversationId === conversationId
        && !nextIds.has(id)
      ) {
        this.removeSkill(id, capability);
      }
    }
    this.skillDiscovery.set(conversationId, {
      routeKey,
      state: {
        truncated,
        warningCount: Math.min(99, Math.max(0, warningCount)),
        synchronizedAt: this.clock().toISOString(),
      },
    });
    return summaries.sort((left, right) =>
      left.scope.localeCompare(right.scope)
      || left.name.localeCompare(right.name));
  }

  private requireNativeCodexGoal(conversation: Conversation): void {
    if (
      !isNativeCodexConversation(conversation)
      || !conversation.providerSessionId
    ) {
      throw new RuntimeRequestError(
        "This conversation does not have a native Codex goal-capable thread.",
      );
    }
  }

  private pruneSkills(): void {
    const now = this.clock().getTime();
    for (const [id, capability] of this.skills) {
      if (capability.expiresAt <= now) {
        this.removeSkill(id, capability);
      }
    }
  }

  private removeSkill(
    id: string,
    capability: PrivateSkillCapability,
  ): void {
    this.skills.delete(id);
    if (this.skillIdsByPath.get(capability.identityKey) === id) {
      this.skillIdsByPath.delete(capability.identityKey);
    }
  }
}
