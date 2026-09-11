import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { startProjectAutoPull } from "../../src/server/runtime/project-auto-pull";
import { automaticPull, automaticPullCandidate } from "../../src/server/git/automatic-pull";

vi.mock("../../src/server/git/automatic-pull", () => ({ automaticPull: vi.fn(), automaticPullCandidate: vi.fn() }));
vi.mock("../../src/server/runtime/worktree-source-identity", () => ({
  pinWorktreeSourceIdentity: vi.fn(async (root: string) => ({ root })),
  verifyWorktreeSourceIdentity: vi.fn(async () => undefined),
}));
const roots: string[] = [];
const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.mocked(automaticPullCandidate).mockResolvedValue("refs/remotes/team/trunk"); vi.mocked(automaticPull).mockResolvedValue(false); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-pull-scheduler-")); roots.push(root);
  const store = new RuntimeStore(join(root, "db.sqlite"), root);
  const project = store.createProject("Project", root);
  store.updateProject(project.id, { preferences: { ...defaultProjectPreferences(), autoPull: true } });
  // Repository discovery is outside this scheduling test; Git safety uses real repositories in git-automatic-pull.test.ts.
  const snapshot = store.shellSnapshot.bind(store);
  vi.spyOn(store, "shellSnapshot").mockImplementation(() => ({ ...snapshot(), projects: snapshot().projects.map((item) => ({ ...item, status: "ready", repositoryRoot: root })) }));
  const controller = new AbortController();
  cleanups.push(() => { controller.abort(); store.close(); });
  const dependencies: Parameters<typeof startProjectAutoPull>[0] = {
    store, signal: controller.signal, idle: vi.fn(() => true), track: vi.fn((operation) => operation()), reportIncident: vi.fn(),
    workspaceRuns: { trackSourceControl: vi.fn(async (_label, _projectId, _conversationId, _root, _requestId, operation) => operation()) },
  };
  return { store, project, controller, dependencies };
}
describe("opt-in project pull scheduling", () => {
  it("does no startup work, skips busy/disabled projects, and never schedules after shutdown", async () => {
    const f = fixture();
    startProjectAutoPull(f.dependencies);
    expect(automaticPullCandidate).not.toHaveBeenCalled();
    vi.mocked(f.dependencies.idle).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(automaticPullCandidate).not.toHaveBeenCalled();
    vi.mocked(f.dependencies.idle).mockReturnValue(true);
    f.store.updateProject(f.project.id, { preferences: defaultProjectPreferences() });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(automaticPullCandidate).not.toHaveBeenCalled();
    f.store.updateProject(f.project.id, { preferences: { ...defaultProjectPreferences(), autoPull: true } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(automaticPull).toHaveBeenCalledTimes(1);
    expect(f.dependencies.workspaceRuns.trackSourceControl).toHaveBeenCalledWith("Automatic pull", f.project.id, undefined, expect.any(String), expect.any(String), expect.any(Function), expect.objectContaining({ exclusiveCheckout: true }));
    f.controller.abort();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(automaticPull).toHaveBeenCalledTimes(1);
  });
  it("bounds a running job with a deadline and aborts it during shutdown without starting another", async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    vi.mocked(automaticPull).mockImplementation(async (_root, _expected, options) => {
      signal = options.signal;
      return new Promise<boolean>((resolve) => { options.signal?.addEventListener("abort", () => resolve(false), { once: true }); });
    });
    startProjectAutoPull(f.dependencies);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(automaticPull).toHaveBeenCalledTimes(2);
    expect(signal?.aborted).toBe(false);
    f.controller.abort();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(signal?.aborted).toBe(true);
    expect(automaticPull).toHaveBeenCalledTimes(2);
    expect(f.dependencies.reportIncident).not.toHaveBeenCalled();
  });
});
