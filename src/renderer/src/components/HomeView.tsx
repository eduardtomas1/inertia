import { FolderPlus, MessageSquarePlus } from "lucide-react";
import type { Project } from "@shared/contracts";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";

interface HomeViewProps {
  projects: Project[];
  connectionStatus: ConnectionStatus;
  importingProject: boolean;
  onCreateConversation: (project: Project) => void;
  onImportProject: () => void;
}

function projectLocation(project: Project): string {
  if (
    project.repositoryRelativePath
    && project.repositoryRelativePath !== "."
  ) {
    return project.repositoryRelativePath;
  }
  return project.path;
}

export function HomeView({
  projects,
  connectionStatus,
  importingProject,
  onCreateConversation,
  onImportProject,
}: HomeViewProps): React.JSX.Element {
  const online = connectionStatus === "online";
  return (
    <main className="home-view" aria-labelledby="home-view-title">
      <section className="home-launcher">
        <div className="home-launcher-heading">
          <span className="welcome-kicker">New chat</span>
          <h2 id="home-view-title">What should we build today?</h2>
          <p>Choose a project to give the conversation its workspace and context.</p>
        </div>

        {projects.length > 0 ? (
          <div className="home-projects" role="list" aria-label="Choose a project">
            {projects.map((project) => (
              <div role="listitem" key={project.id}>
                <button
                  type="button"
                  className="home-project"
                  disabled={!online}
                  onClick={() => onCreateConversation(project)}
                  aria-label={`New chat in ${project.name}`}
                >
                  <span
                    className="home-project-mark"
                    style={{ "--project-color": project.color } as React.CSSProperties}
                    aria-hidden="true"
                  >
                    <MessageSquarePlus size={17} />
                  </span>
                  <span className="home-project-copy">
                    <strong>{project.name}</strong>
                    <small title={project.path}>{projectLocation(project)}</small>
                  </span>
                  <span className={`home-project-status status-${project.status}`}>
                    {project.status === "attention"
                      ? "Needs attention"
                      : project.status === "working"
                        ? "Working"
                        : "Ready"}
                  </span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="home-projects-empty">
            <p>Add a project before starting your first chat.</p>
          </div>
        )}

        <button
          type="button"
          className="home-add-project"
          disabled={!online || importingProject}
          onClick={onImportProject}
        >
          <FolderPlus size={15} />
          <span>{importingProject ? "Adding project…" : "Add project"}</span>
        </button>
      </section>
    </main>
  );
}
