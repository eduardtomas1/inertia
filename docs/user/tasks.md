# Tasks

**Tasks** is a local to-do list for work you want to remember or hand to an agent. Open it with **Tasks** in the sidebar, or search for **Open tasks** with ⌘K (Ctrl+K elsewhere).

- **Add a task** in the field at the top. Enter adds it; Tab adds it and opens its details at **Hand it to an agent**.
- **Open a task** to edit its title and add a note.
- **Due date:** choose **Today**, **Tomorrow**, **Next week** or **No date**.
- **Priority:** choose **Urgent**, **High**, **Medium**, **Low** or **No priority**.
- **Hand it to an agent:** pick the model, reasoning, speed where the model offers it, and the project or a folder. Inertia starts a new chat in the background with the task's title and note as its first message.
- A handed-off task shows its chat's state: **Working**, **Needs attention**, **Done** or **Failed**. **Open chat** opens it.
- **Mark as done** moves a task to the **Done** list; **Reopen** brings it back. A task's actions also offer **Rename**, **Delete** and, once linked to a chat, **Open chat**.

## Create a task from a chat

You can also turn something in a chat into a task without leaving it. The new task is linked to that chat, so it shows the chat's state and offers **Open chat** just like a handed-off task. Because it already has a chat, it isn't handed to an agent again.

- **From a message:** right-click one of your messages or an agent's reply (or focus it and press Shift+F10) and choose **Create task from message**. The first line of the message becomes the task's title and the whole message becomes its note. Very long text is shortened and ends with "…".
- **From a plan step:** in the **Plan** panel, point at a step or move focus to it and choose **Create task**. The step becomes the title, and the note says which chat's plan it came from, followed by the step's details. This works for plans the agent reports and for steps Inertia picks out of a reply.

A short **Task created** confirmation appears; **Open tasks** takes you to the list. Creating tasks from a chat is available in the main window only, not in a chat opened in its own window.

Tasks stay on this computer with the rest of your history. To pin or snooze a chat instead, use the chat's actions; see [Chats and agents](chats-and-agents.md#keep-work-organized).
