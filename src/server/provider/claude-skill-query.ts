import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type Query,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

import {
  createClaudeOwnedQueryProcess,
  type ClaudeOwnedQueryDependencies,
} from "./claude-owned-query";
import {
  CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
  CLAUDE_ISOLATED_SKILL_SETTINGS,
  discoverClaudeFilesystemSkills,
  stageClaudeSkillPlugin,
  type ClaudeFilesystemSkill,
} from "./claude-skill-plugin";
import {
  checkClaudeSkillOperation,
  createClaudeSkillDeadline,
  raceClaudeSkillOperation,
  type ClaudeSkillFilesystemTestSeam,
} from "./claude-skill-operation";

export type ClaudeQueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: ClaudeOptions;
}) => Query;

async function queryClaudeSkills(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  forceReload: boolean,
  createQuery: ClaudeQueryFactory,
  lifecycleDependencies: ClaudeOwnedQueryDependencies,
  filesystem: ClaudeSkillFilesystemTestSeam,
  signal: AbortSignal,
  registerCleanup: (cleanup: Promise<void>) => void,
): Promise<ClaudeFilesystemSkill[]> {
  const control = { ...filesystem, signal };
  const discovered = await discoverClaudeFilesystemSkills(
    cwd,
    environment,
    control,
  );
  const nameCounts = new Map<string, number>();
  for (const { name } of discovered) {
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const unambiguous = discovered.filter(({ name }) =>
    nameCounts.get(name) === 1);
  if (unambiguous.length === 0) return [];
  const staged = await stageClaudeSkillPlugin(
    unambiguous.map(({ name, path }) => ({
      source: "claude-native" as const,
      name,
      path,
    })),
    cwd,
    environment,
    { ...control, metadataOnly: true },
  );
  if (!staged) return [];
  checkClaudeSkillOperation(control);
  const abortController = new AbortController();
  const ownedProcess = createClaudeOwnedQueryProcess(
    "Claude skill discovery process tree",
    lifecycleDependencies,
  );
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  async function* dormantPrompt(): AsyncIterable<SDKUserMessage> {
    await hold;
    yield* [] as SDKUserMessage[];
  }
  let query: Query | undefined;
  let cleanup: Promise<void> | undefined;
  const cleanupOwnedResources = (): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
    signal.removeEventListener("abort", abortSdk);
    ownedProcess.requestTermination(true);
    release();
    abortController.abort();
    try { query?.close(); } catch { /* The SDK process may already have exited. */ }
    let cleanupError: unknown;
    try { await ownedProcess.terminate(true); } catch (error) { cleanupError = error; }
    try { await staged.cleanup(); } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw cleanupError;
    })();
    registerCleanup(cleanup);
    return cleanup;
  };
  const abortSdk = (): void => {
    abortController.abort();
    // An SDK control promise may ignore abort forever. Cleanup therefore has
    // its own signal path rather than depending on the await below settling.
    void cleanupOwnedResources().catch(() => undefined);
  };
  if (signal.aborted) abortSdk();
  else signal.addEventListener("abort", abortSdk, { once: true });
  checkClaudeSkillOperation(control);
  let supported: SlashCommand[] | undefined;
  let operationError: unknown;
  try {
    query = createQuery({
      prompt: dormantPrompt(),
      options: {
        abortController,
        cwd,
        env: environment,
        pathToClaudeCodeExecutable: executable,
        spawnClaudeCodeProcess: ownedProcess.spawnClaudeCodeProcess,
        settingSources: [],
        managedSettings: CLAUDE_ISOLATED_SKILL_SETTINGS,
        plugins: [{ type: "local", path: staged.path, skipMcpDiscovery: true }],
        skills: "all",
      },
    });
    supported = forceReload
      ? (await query.reloadSkills()).skills
      : await query.supportedCommands();
  } catch (error) {
    operationError = error;
  } finally {
    await cleanupOwnedResources();
  }
  if (operationError) throw operationError;
  const names = new Set((supported ?? []).map(({ name }) => name));
  return unambiguous.filter(({ name }) =>
    names.has(`${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:${name}`));
}

export async function readClaudeAgentSdkSkills(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  forceReload = false,
  timeoutMs = 6_000,
  createQuery: ClaudeQueryFactory = claudeQuery,
  lifecycleDependencies: ClaudeOwnedQueryDependencies = {},
  filesystem: ClaudeSkillFilesystemTestSeam = {},
): Promise<ClaudeFilesystemSkill[]> {
  const deadline = createClaudeSkillDeadline(
    timeoutMs,
    "Claude skill discovery timed out.",
  );
  let cleanup: Promise<void> | undefined;
  const operation = queryClaudeSkills(
    executable,
    environment,
    cwd,
    forceReload,
    createQuery,
    lifecycleDependencies,
    filesystem,
    deadline.signal,
    (value) => { cleanup = value; },
  );
  try {
    return await raceClaudeSkillOperation(operation, deadline.signal);
  } catch (error) {
    if (cleanup) await cleanup;
    throw error;
  } finally {
    deadline.dispose();
  }
}
