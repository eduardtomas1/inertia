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
  RuntimeSequencer,
  type RuntimeDetailSubscription,
  type RuntimeResumeRequest,
} from "../runtime-sequencing";
import {
  projectDetachedChatSnapshot,
  projectRuntimeFrameForAuthority,
} from "./detached-chat-runtime-projection";
import {
  MAIN_RUNTIME_CLIENT_AUTHORITY,
  type RuntimeClientAuthority,
} from "./runtime-client-authority";

export interface RuntimeSyncHydration {
  beforeFreshSnapshot?(): void;
  snapshot: (sync: RuntimeSyncCursor) => AppSnapshot;
  approvals: Iterable<AgentApprovalRequest>;
  inputs: Iterable<AgentInputRequest>;
  plans: Iterable<AgentPlan>;
}

type RuntimeSubscriptionOwner = "primary" | "secondary";

interface RuntimeClientSubscription extends RuntimeDetailSubscription {
  authority: RuntimeClientAuthority;
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
    authority: RuntimeClientAuthority = MAIN_RUNTIME_CLIENT_AUTHORITY,
  ): void {
    const resumedConversationIds = authority.kind === "detached-chat"
      ? [authority.conversationId]
      : resumeRequest.kind === "resume"
        ? [...resumeRequest.conversationIds]
        : [];
    const subscription: RuntimeClientSubscription = {
      authority,
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

    // Flush live state before owning a fresh socket. Existing clients receive
    // any final transient suffix, while the new client receives that same
    // suffix exactly once through its durable snapshot.
    if (replay?.kind !== "replay") {
      hydration.beforeFreshSnapshot?.();
    }
    // Own the socket before the first frame is sent. A synchronous close or
    // response to server.welcome must observe an already registered client.
    this.clients.set(socket, subscription);
    if (replay?.kind === "replay") {
      this.send(socket, {
        type: "runtime.resumed",
        protocolVersion: PROTOCOL_VERSION,
        sync: replay.cursor,
      });
      for (const frame of replay.frames) {
        this.send(socket, frame.type === "runtime.event"
          ? projectRuntimeFrameForAuthority(
              frame,
              subscription,
              authority,
            )
          : frame);
      }
    } else {
      const sync = this.sequencer.cursor();
      const snapshot = hydration.snapshot(sync);
      this.send(socket, {
        type: "server.welcome",
        protocolVersion: PROTOCOL_VERSION,
        snapshot: authority.kind === "detached-chat"
          ? projectDetachedChatSnapshot(snapshot, authority.conversationId)
          : snapshot,
        sync,
      });
      for (const request of hydration.approvals) {
        if (
          authority.kind === "detached-chat"
          && request.conversationId !== authority.conversationId
        ) continue;
        this.send(socket, { type: "agent.approval.requested", request });
      }
      for (const request of hydration.inputs) {
        if (
          authority.kind === "detached-chat"
          && request.conversationId !== authority.conversationId
        ) continue;
        this.send(socket, { type: "agent.input.requested", request });
      }
      for (const plan of hydration.plans) {
        if (
          authority.kind === "detached-chat"
          && plan.conversationId !== authority.conversationId
        ) continue;
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
    if (subscription.authority.kind === "detached-chat") {
      subscription.mountedConversations = {
        primary: subscription.authority.conversationId,
        secondary: null,
      };
      subscription.conversationIds = [
        subscription.authority.conversationId,
      ];
      return;
    }
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
      || subscription.authority.kind === "detached-chat"
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
        projectRuntimeFrameForAuthority(
          frame,
          subscription,
          subscription.authority,
        ),
      );
    }
  }
}
