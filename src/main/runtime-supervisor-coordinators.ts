import type { RuntimeWorkerCommand } from "../node/runtime-process-protocol.js";
import { AGENT_SECRET_DELIVERY_TIMEOUT_MS, RuntimeAgentSecretCoordinator } from "./runtime-agent-secret-coordinator.js";
import { RuntimeAttachmentBrokerCoordinator } from "./runtime-attachment-broker.js";
import { RuntimeCredentialCoordinator } from "./runtime-credential-coordinator.js";
import { RuntimeDatabaseRecoveryCoordinator } from "./runtime-database-recovery-coordinator.js";
import { RuntimeHtmlRenderCoordinator } from "./runtime-html-render-coordinator.js";
import { RuntimePrivateConnectPromptCoordinator } from "./runtime-private-connect-prompt-coordinator.js";
import { RuntimePrivateConnectRequestCoordinator } from "./runtime-private-connect-request-coordinator.js";
import { RuntimeSecureFileCoordinator } from "./runtime-secure-file-coordinator.js";
import { RuntimeUpdatePreparationCoordinator } from "./runtime-update-preparation-coordinator.js";
import type { RuntimeProcessRecord, RuntimeSupervisorOptions } from "./runtime-supervisor-types.js";
import { boundedDuration, runtimeSupervisorDefaults } from "./runtime-supervisor-values.js";

export interface RuntimeSupervisorCoordinatorHost {
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
  post(record: RuntimeProcessRecord, command: RuntimeWorkerCommand): boolean;
  accepts(record: RuntimeProcessRecord): boolean;
  readyRecord(): RuntimeProcessRecord | Error;
  readyCurrent(): RuntimeProcessRecord | null;
  forceTerminate(record: RuntimeProcessRecord): void;
  databaseRecoveryCancellationUnconfirmed(record: RuntimeProcessRecord): void;
}

export function createRuntimeSupervisorCoordinators(
  options: RuntimeSupervisorOptions,
  host: RuntimeSupervisorCoordinatorHost,
) {
  const timers = { setTimer: host.setTimer, clearTimer: host.clearTimer };
  const post = (record: RuntimeProcessRecord, command: RuntimeWorkerCommand): boolean =>
    host.post(record, command);
  const accepts = (record: RuntimeProcessRecord): boolean => host.accepts(record);
  return {
    privateConnectPrompts: new RuntimePrivateConnectPromptCoordinator<RuntimeProcessRecord>({
      timeoutMs: runtimeSupervisorDefaults.requestTimeoutMs,
      ...timers,
      post,
    }),
    credentials: new RuntimeCredentialCoordinator({
      broker: options.credentialBroker,
      timeoutMs: boundedDuration(options.credentialRequestTimeoutMs,
        runtimeSupervisorDefaults.credentialRequestTimeoutMs),
      ...timers,
      accepts,
      post,
    }),
    secureFiles: new RuntimeSecureFileCoordinator({
      retryUnconfirmedShutdown: true, broker: options.secureFileBroker,
      conversationAttachmentStoreRunner:
        options.conversationAttachmentStoreRunner,
      documentPreparationRunner: options.documentPreparationRunner,
      conversationAttachmentSourceRoot: options.conversationAttachmentSourceRoot,
      conversationAttachmentStoreAuthority:
        options.conversationAttachmentStoreAuthority,
      agentBrowserBroker: options.agentBrowserBroker,
      issueEvidenceBroker: options.issueEvidenceBroker,
      accepts,
      post,
    }),
    attachmentRequests: new RuntimeAttachmentBrokerCoordinator<RuntimeProcessRecord>({
      broker: options.attachmentBroker,
      timeoutMs: boundedDuration(
        options.attachmentRequestTimeoutMs,
        runtimeSupervisorDefaults.requestTimeoutMs,
      ),
      ...timers,
      accepts,
      post,
    }),
    databaseRecoveryRequests: new RuntimeDatabaseRecoveryCoordinator({
      requestTimeoutMs: boundedDuration(
        options.databaseRecoveryRequestTimeoutMs,
        runtimeSupervisorDefaults.databaseRecoveryTimeoutMs,
      ),
      cancelTimeoutMs: boundedDuration(
        options.databaseRecoveryCancelTimeoutMs,
        runtimeSupervisorDefaults.databaseRecoveryCancelTimeoutMs,
      ),
      ...timers,
      post,
      cancellationUnconfirmed: (record) =>
        host.databaseRecoveryCancellationUnconfirmed(record),
    }),
    privateConnectRequests: new RuntimePrivateConnectRequestCoordinator({
      requestTimeoutMs: runtimeSupervisorDefaults.requestTimeoutMs,
      ...timers,
      post,
    }),
    htmlRenders: new RuntimeHtmlRenderCoordinator({
      requestTimeoutMs: runtimeSupervisorDefaults.requestTimeoutMs,
      ...timers,
      readyRecord: () => host.readyRecord(),
      post,
    }),
    agentSecrets: new RuntimeAgentSecretCoordinator({
      timeoutMs: AGENT_SECRET_DELIVERY_TIMEOUT_MS,
      ...timers,
      readyRecord: () => host.readyRecord(),
      post,
    }),
    updatePreparation: new RuntimeUpdatePreparationCoordinator({
      timeoutMs: runtimeSupervisorDefaults.requestTimeoutMs,
      ...timers,
      current: () => host.readyCurrent(),
      post,
      forceTerminate: (record) => host.forceTerminate(record),
    }),
  };
}
