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

type RuntimeSubscriptionOwner = "primary" | "secondary";

interface RuntimeClientSubscription extends RuntimeDetailSubscription {
  mountedConversations: Record<
    RuntimeSubscriptionOwner,
    string | null
  >;
}

/**
 * Owns synchronization state for connected renderer sockets: subscriptions,
 * monotonic publication, replay, fresh hydration, and connection teardown.
 * Socket admission and command execution remain in the protocol layer.
 */
export class RuntimeSyncHub<Socket> {
  private readonly clients = new Map<Socket, RuntimeClientSubscription>();

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
    const resumedConversationIds = resumeRequest.kind === "resume"
      ? [...resumeRequest.conversationIds]
      : [];
    const subscription: RuntimeClientSubscription = {
      conversationIds: resumedConversationIds,
      mountedConversations: {
        primary: resumedConversationIds[0] ?? null,
        secondary: resumedConversationIds[1] ?? null,
      },
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

  setConversationSubscription(
    socket: Socket,
    owner: RuntimeSubscriptionOwner,
    conversationId: string | null,
  ): void {
    const subscription = this.clients.get(socket);
    if (!subscription) return;
    subscription.mountedConversations[owner] = conversationId;
    subscription.conversationIds = [
      subscription.mountedConversations.primary,
      subscription.mountedConversations.secondary,
    ].filter((id, index, ids): id is string =>
      id !== null && ids.indexOf(id) === index);
  }

  /**
   * Keeps detail.load compatible with older renderers and direct protocol
   * clients. Explicit pane ownership remains authoritative; an unowned load
   * fills an empty slot or replaces only the secondary slot, so it can never
   * evict the visible primary conversation.
   */
  ensureConversationSubscription(
    socket: Socket,
    conversationId: string,
  ): void {
    const subscription = this.clients.get(socket);
    if (
      !subscription
      || subscription.conversationIds.includes(conversationId)
    ) return;
    const owner = subscription.mountedConversations.primary === null
      ? "primary"
      : "secondary";
    this.setConversationSubscription(socket, owner, conversationId);
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
