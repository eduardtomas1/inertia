import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import { MAX_SCHEDULED_TASK_RUN_HISTORY } from "../../../shared/scheduled-tasks";
import type { ScheduledTaskService } from "../scheduled-tasks/scheduled-task-service";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface ScheduledTaskCommandDependencies {
  scheduledTasks: Pick<
    ScheduledTaskService,
    "listSummaries" | "create" | "update" | "delete" | "runNow" | "listRuns"
  >;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createScheduledTaskCommandHandler(
  dependencies: ScheduledTaskCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(
    [
      "scheduled-task.list",
      "scheduled-task.create",
      "scheduled-task.update",
      "scheduled-task.delete",
      "scheduled-task.run-now",
    ],
    async (socket, command) => {
      switch (command.type) {
        case "scheduled-task.list": {
          const tasks = dependencies.scheduledTasks.listSummaries(command.payload?.projectId);
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "scheduled-tasks.list", tasks },
          });
          return "handled";
        }
        case "scheduled-task.create": {
          const task = dependencies.scheduledTasks.create(command.payload);
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "scheduled-task", task, recentRuns: [] },
          });
          return "handled";
        }
        case "scheduled-task.update": {
          const task = dependencies.scheduledTasks.update(
            command.payload.taskId,
            command.payload.patch,
          );
          const recentRuns = dependencies.scheduledTasks.listRuns(
            task.id,
            MAX_SCHEDULED_TASK_RUN_HISTORY,
          );
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "scheduled-task", task, recentRuns },
          });
          return "handled";
        }
        case "scheduled-task.delete": {
          dependencies.scheduledTasks.delete(command.payload.taskId);
          dependencies.send(socket, {
            type: "request.ok",
            requestId: command.requestId,
          });
          return "handled";
        }
        case "scheduled-task.run-now": {
          const { task, run, conversationId } = await dependencies.scheduledTasks.runNow(
            command.payload.taskId,
          );
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "scheduled-task.ran",
              task,
              run,
              conversationId,
            },
          });
          return "handled";
        }
        default:
          return "not-handled";
      }
    },
  );
}
