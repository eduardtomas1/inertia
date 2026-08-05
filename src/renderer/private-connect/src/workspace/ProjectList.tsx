import type { Shell } from "../types";

export function ProjectList({
  shell,
  selectedConversation,
  onSelect,
}: {
  shell: Shell | null;
  selectedConversation: string | null;
  onSelect: (conversationId: string) => void;
}): React.JSX.Element {
  return (
    <aside>
      <h2>Projects</h2>
      {shell?.projects.map((project) => (
        <section key={project.id}>
          <h3>{project.name}</h3>
          {shell.conversations
            .filter((conversation) => conversation.projectId === project.id)
            .map((conversation) => (
              <button
                type="button"
                className={selectedConversation === conversation.id ? "conversation-link selected" : "conversation-link"}
                key={conversation.id}
                onClick={() => onSelect(conversation.id)}
              >
                <span>{conversation.title}</span>
                <small>{conversation.status}</small>
              </button>
            ))}
        </section>
      ))}
    </aside>
  );
}
