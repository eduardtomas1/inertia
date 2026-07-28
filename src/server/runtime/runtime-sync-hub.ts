import {
  PROTOCOL_VERSION,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AppSnapshot,
  type RuntimeMutationEvent,
  type RuntimeSyncCursor,
  type ServerEvent,
} from "../../shared/contracts";
import {
  projectRuntimeFrame,
  RuntimeSequencer,
  type RuntimeDetailSubscription,
  type RuntimeResumeRequest,
} from "../runtime-sequencing";

export interface RuntimeSyncHydration {
  snapshot: (sync: RuntimeSyncCursor) => AppSnapshot;
  approvals: Iterable<AgentApprovalRequest>;
  inputs: Iterable<AgentInputRequest>;
  plans: Iterable<AgentPlan>;
}

/**
 * Owns synchronization state for connected renderer sockets: subscriptions,
 * monotonic publication, replay, fresh hydration, and connection teardown.
 * Socket admission and command execution remain in the protocol layer.
 */
export class RuntimeSyncHub<Socket> {
  private readonly clients = new Map<Socket, RuntimeDetailSubscription>();

  constructor(
    private readonly send: (socket: Socket, event: ServerEvent) => void,
    private readonly sequencer = new RuntimeSequencer(),
  ) {}

  get connectionCount(): number {
    return this.clients.size;
  }

  cursor(): RuntimeSyncCursor {
    return this.sequencer.cursor();
  }

  connect(
    socket: Socket,
    resumeRequest: RuntimeResumeRequest,
    hydration: RuntimeSyncHydration,
  ): void {
    const subscription = {
      conversationIds: resumeRequest.kind === "resume"
        ? [...resumeRequest.conversationIds]
        : [],
    };
    const replay = resumeRequest.kind === "resume"
      ? this.sequencer.replay(
          resumeRequest.runtimeGeneration,
          resumeRequest.afterSequence,
          subscription,
        )
      : null;

    // Own the socket before the first frame is sent. A synchronous close or
    // response to server.welcome must observe an already registered client.
    this.clients.set(socket, subscription);
    if (replay?.kind === "replay") {
      this.send(socket, {
        type: "runtime.resumed",
        protocolVersion: PROTOCOL_VERSION,
        sync: replay.cursor,
      });
      for (const frame of replay.frames) this.send(socket, frame);
    } else {
      const sync = this.sequencer.cursor();
      this.send(socket, {
        type: "server.welcome",
        protocolVersion: PROTOCOL_VERSION,
        snapshot: hydration.snapshot(sync),
        sync,
      });
      for (const request of hydration.approvals) {
        this.send(socket, { type: "agent.approval.requested", request });
      }
      for (const request of hydration.inputs) {
        this.send(socket, { type: "agent.input.requested", request });
      }
      for (const plan of hydration.plans) {
        this.send(socket, { type: "agent.plan.updated", plan });
      }
    }

    this.send(socket, {
      type: "runtime.sync.completed",
      sync: this.sequencer.cursor(),
    });
  }

  setConversationSubscription(socket: Socket, conversationId: string): void {
    const subscription = this.clients.get(socket);
    if (!subscription) return;
    subscription.conversationIds = [
      ...subscription.conversationIds.filter((id) => id !== conversationId),
      conversationId,
    ].slice(-2);
  }

  disconnect(socket: Socket): void {
    this.clients.delete(socket);
  }

  broadcast(event: RuntimeMutationEvent): void {
    this.broadcastCommitted(() => event);
  }

  broadcastSnapshot(snapshot: (sync: RuntimeSyncCursor) => AppSnapshot): void {
    this.broadcastCommitted((sync) => ({
      type: "snapshot.updated",
      snapshot: snapshot(sync),
    }));
  }

  terminateAll(terminate: (socket: Socket) => void): void {
    for (const socket of this.clients.keys()) terminate(socket);
    this.clients.clear();
  }

  private broadcastCommitted(
    createEvent: (sync: RuntimeSyncCursor) => RuntimeMutationEvent,
  ): void {
    const frame = this.sequencer.commit(createEvent);
    for (const [socket, subscription] of this.clients) {
      this.send(
        socket,
        projectRuntimeFrame(frame, subscription),
      );
    }
  }
}
