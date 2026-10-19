import { useEffect, useRef } from "react";

import type { Project } from "@shared/contracts";
import type { LaunchProjectRequest } from "@shared/desktop";

function containsPath(root: string, target: string): boolean {
  if (target === root) return true;
  const base = root.replace(/[\\/]+$/u, "");
  return target.startsWith(`${base}/`) || target.startsWith(`${base}\\`);
}

export function launchRequestProject(
  projects: readonly Project[],
  request: LaunchProjectRequest,
): Project | null {
  const targets = [request.path, request.realPath].filter((target): target is string => Boolean(target));
  let match: Project | null = null;
  let matchLength = -1;
  for (const project of projects) {
    if (project.workspaceKind === "scratch") continue;
    for (const root of new Set([project.path, project.normalizedPath])) {
      if (!root || root.length <= matchLength) continue;
      if (targets.some((target) => containsPath(root, target))) {
        match = project;
        matchLength = root.length;
      }
    }
  }
  return match;
}

export function useLaunchRequests({
  ready,
  projects,
  openProject,
  addProject,
}: {
  ready: boolean;
  projects: readonly Project[];
  openProject: (project: Project) => void;
  addProject: (path: string) => Promise<void>;
}): void {
  const latest = useRef({ projects, openProject, addProject });
  latest.current = { projects, openProject, addProject };

  useEffect(() => {
    const bridge = window.inertia;
    if (!ready || !bridge?.takeLaunchRequests) return;
    let active = true;
    let tail = Promise.resolve();
    const drain = (): void => {
      tail = tail.then(async () => {
        const requests = await bridge.takeLaunchRequests().catch(() => []);
        for (const request of requests) {
          if (!active) return;
          const current = latest.current;
          const project = launchRequestProject(current.projects, request);
          if (project) current.openProject(project);
          else await current.addProject(request.realPath ?? request.path);
        }
      }).catch(() => undefined);
    };
    drain();
    const unsubscribe = bridge.onLaunchRequest(drain);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [ready]);
}
