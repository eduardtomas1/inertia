import { describe, expect, it } from "vitest";

import * as attachmentExports from "../src/shared/attachments";
import * as backendProfileExports from "../src/shared/backend-profile-settings";
import * as facadeExports from "../src/shared/contracts";
import * as agentExports from "../src/shared/contracts/agent";
import * as agentWorkflowExports from "../src/shared/contracts/agent-workflows";
import * as appExports from "../src/shared/contracts/app";
import * as clientCommandExports from "../src/shared/contracts/client-command";
import * as conversationContextExports from "../src/shared/conversation-context";
import * as duoExports from "../src/shared/contracts/duo";
import * as eventExports from "../src/shared/contracts/events";
import * as modelRoutingExports from "../src/shared/model-routing";
import * as providerMaintenanceExports from "../src/shared/provider-maintenance";
import * as providerTerminalResumeExports from "../src/shared/provider-terminal-resume";
import * as runStateExports from "../src/shared/run-state";
import * as usageDashboardExports from "../src/shared/contracts/usage-dashboard";
import * as workspaceExports from "../src/shared/contracts/workspace";
import { clientCommandSchema } from "../src/shared/contracts/client-command";

describe("shared contracts boundary", () => {
  it("keeps the compatibility facade's runtime exports exact", () => {
    const domainExports = {
      ...modelRoutingExports,
      ...backendProfileExports,
      ...attachmentExports,
      ...providerMaintenanceExports,
      ...providerTerminalResumeExports,
      ...runStateExports,
      ...agentExports,
      ...agentWorkflowExports,
      ...appExports,
      ...clientCommandExports,
      ...conversationContextExports,
      ...duoExports,
      ...eventExports,
      ...usageDashboardExports,
      ...workspaceExports,
    };

    expect(Object.keys(facadeExports).sort()).toEqual(Object.keys(domainExports).sort());
    for (const [name, value] of Object.entries(domainExports)) {
      expect(facadeExports[name as keyof typeof facadeExports]).toBe(value);
    }
  });

  it("retains every client command discriminant exactly once", () => {
    const commandTypes = clientCommandSchema.options.flatMap((schema) => {
      const typeSchema = schema.shape.type;
      return "options" in typeSchema
        ? [...typeSchema.options]
        : [...typeSchema.values];
    });

    expect(commandTypes).toEqual([
      "app.refresh",
      "daily.work.get",
      "usage.dashboard.get",
      "provider.refresh",
      "provider.auth.start",
      "provider.maintenance.refresh",
      "provider.maintenance.update",
      "provider.maintenance.cancel",
      "project.create",
      "project.select",
      "project.remove",
      "project.update",
      "conversation.create",
      "duo.prepare",
      "duo.pending",
      "duo.dispatch",
      "duo.cancel",
      "duo.status",
      "duo.acknowledge",
      "duo.comparison.retry",
      "duo.comparison.cancel",
      "conversation.select",
      "conversation.detail.load",
      "conversation.detail.subscription",
      "conversation.context.source.load",
      "conversation.context.agent.source.load",
      "conversation.context.agent.respond",
      "conversation.context.create",
      "conversation.context.load",
      "conversation.context.remove",
      "conversation.update",
      "conversation.archive",
      "conversation.unarchive",
      "conversation.settle",
      "conversation.unsettle",
      "conversation.delete",
      "message.send",
      "conversation.compact",
      "agent.workflow.load",
      "agent.workflow.saved.load",
      "agent.goal.set",
      "agent.goal.clear",
      "agent.skills.list",
      "agent.stop",
      "agent.subagent.stop",
      "activity.stop",
      "activity.dismiss",
      "activity.mark-seen",
      "activity.acknowledge",
      "agent.approval.respond",
      "agent.input.respond",
      "settings.update",
      "backend.profile.get",
      "backend.profile.create",
      "backend.profile.update",
      "backend.profile.credential-revision",
      "backend.profile.probe",
      "backend.profile.delete",
      "backend.default.set",
      "backend.default.clear",
      "prompt-preset.create",
      "prompt-preset.update",
      "prompt-preset.duplicate",
      "prompt-preset.delete",
      "prompt-preset.reorder",
      "git.refresh",
      "git.diff",
      "git.workspace.refresh",
      "git.workspace.diff",
      "git.turn.diff",
      "git.turn.compare",
      "git.selection.inspect",
      "git.selection.revert",
      "git.selection.undo",
      "review.selection.ask",
      "review.selection.cancel",
      "review.selection.revise",
      "review.state.set",
      "review.note.create",
      "review.note.update",
      "review.note.delete",
      "review.summary.generate",
      "review.summary.cancel",
      "git.branches",
      "git.branch.create",
      "git.branch.switch",
      "git.pull",
      "git.commit",
      "git.push",
      "git.pr.open",
      "git.pr.confidence",
      "git.pr.create",
      "workspace.entries",
      "workspace.file.read",
      "workspace.file.write",
      "project.actions",
      "project.action.run",
      "checkpoint.revert",
      "terminal.create",
      "terminal.provider.resume",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
    ]);
    expect(new Set(commandTypes).size).toBe(commandTypes.length);
  });

  it("bounds Duo reconciliation to both sources and one judge project", () => {
    const projectIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const command = (ids: string[]) => ({
      type: "duo.pending",
      requestId: "44444444-4444-4444-8444-444444444444",
      payload: { projectIds: ids },
    });

    expect(clientCommandSchema.safeParse(command(projectIds)).success).toBe(true);
    expect(clientCommandSchema.safeParse(command([
      ...projectIds,
      "55555555-5555-4555-8555-555555555555",
    ])).success).toBe(false);
  });
});
