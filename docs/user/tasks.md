# Tasks

**Tasks** is a local to-do list for work you want to remember or hand to an agent. Open it with **Tasks** in the sidebar, press ⌘T (Ctrl+T elsewhere) to open it with the cursor in the add row, or search for **Open tasks** or **Add a task** with ⌘K (Ctrl+K elsewhere).

- **Add a task** in the field at the top. Enter adds it; Tab adds it and opens its details at **Hand it to an agent**.
- **Open a task** to edit its title and add a note.
- **Due:** choose **Today**, **Tomorrow** or **Next week**, or a day in the calendar, and optionally a time such as `15:00` or `3pm`. An overdue task's due label turns red.
- **Priority:** choose **Urgent**, **High**, **Medium**, **Low** or no priority.
- **Project:** a task belongs to a project, or to none. When the sidebar is scoped to a project, Tasks shows that project's tasks and the unassigned ones, and new tasks join that project.
- **Hand it to an agent:** pick the model, reasoning, speed where the model offers it, and the project or a folder. Inertia starts a new chat in the background with the task's title and note as its first message, and you stay in Tasks.
- A linked task shows what its chat is doing: **Starting…**, **Working…**, **Needs your OK**, **Asked you a question**, **Hit a usage limit**, **Ready for you**, **Failed**, **Stopped** or **Chat archived**. **Open chat** opens it. A failed, stopped or archived task offers **Try again** or **Hand off again**, which starts a fresh chat and links the task to it.
- The list puts what needs you first, then failed, ready, working and to-do tasks.
- Only the checkbox or **Mark as done** marks a task as done; the agent finishing does not. **Reopen** brings a done task back, and **Clear done** removes the done tasks. A task's actions also offer **Rename**, **Delete** (with **Undo**) and, once linked to a chat, **Open chat**.

## Create a task from a chat

You can also turn something in a chat into a task without leaving it. The new task joins that chat's project and remembers where it came from: its details show **From chat** followed by the chat's title, and choosing it opens that chat. The task is not handed to that chat or to any agent; it starts as an ordinary task in **To do**, and you can hand it off like any other. If the chat is deleted later, the task stays and the **From chat** chip goes away.

- **From a message:** right-click one of your messages or an agent's reply (or focus it and press Shift+F10) and choose **Create task from message**. The first line of the message becomes the task's title and the whole message becomes its note. Very long text is shortened and ends with "…".
- **From a plan step:** in the **Plan** panel, point at a step or move focus to it and choose **Create task**. The step becomes the title, and the note says which chat's plan it came from, followed by the step's details. This works for plans the agent reports and for steps Inertia picks out of a reply.

A short **Task created** confirmation appears; **Open tasks** takes you to the list. It stays while the pointer rests on it or focus is inside it, and dismissing it returns focus to where you were. Choosing the action again while the first task is still being written does not create a second copy. Creating tasks from a chat is available in the main window only, not in a chat opened in its own window.

Tasks stay on this computer with the rest of your history. To pin or snooze a chat instead, use the chat's actions; see [Chats and agents](chats-and-agents.md#keep-work-organized).
