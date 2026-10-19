import { useEffect, useRef } from "react";

import type { Project } from "@shared/contracts";
import type { LaunchProjectRequest } from "@shared/desktop";

function comparablePath(path: string): string {
  const windows = /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith("\\\\");
  const unified = path.replace(/\\/gu, "/").replace(/\/+$/u, "") || "/";
  return windows ? unified.toLowerCase() : unified;
}

function depthBelow(root: string, target: string): number | null {
  const base = comparablePath(root);
  const path = comparablePath(target);
  if (path === base) return 0;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length).split("/").filter(Boolean).length;
}

export function launchRequestProject(
  projects: readonly Project[],
  request: LaunchProjectRequest,
): Project | null {
  const targets = [request.path, request.realPath].filter((target): target is string => Boolean(target));
  let match: Project | null = null;
  let matchDepth = Number.POSITIVE_INFINITY;
  for (const project of projects) {
    if (project.workspaceKind === "scratch") continue;
    for (const root of new Set([project.path, project.normalizedPath])) {
      if (!root) continue;
      for (const target of targets) {
        const depth = depthBelow(root, target);
        if (depth !== null && depth < matchDepth) {
          match = project;
          matchDepth = depth;
        }
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
