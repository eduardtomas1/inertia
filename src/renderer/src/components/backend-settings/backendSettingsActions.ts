import type {
  BackendDiscoveredModel,
  ModelBackendProfileCreateDraft,
  ModelBackendProfileDetail,
} from "@shared/contracts";
import { MAX_BACKEND_PROBE_MODELS } from "@shared/backend-profile-settings";
import { ELECTRON_IPC_ERROR_PREFIX } from "../../hooks/useDesktopTools";
import type { BackendProbeOutcome } from "../../hooks/useBackendProfiles";
import type { BackendProfileUpdateInput } from "../../lib/backendProfileCommands";

export interface BackendProfileActions {
  onLoadDetail: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onCreate: (draft: ModelBackendProfileCreateDraft) => Promise<ModelBackendProfileDetail>;
  onUpdate: (
    profileId: string,
    update: BackendProfileUpdateInput,
  ) => Promise<ModelBackendProfileDetail>;
  onSetCredential: (
    profileId: string,
    secret: string,
  ) => Promise<ModelBackendProfileDetail>;
  onClearCredential: (profileId: string) => Promise<ModelBackendProfileDetail>;
  onProbe: (
    profileId: string,
    modelIds?: readonly string[],
  ) => Promise<BackendProbeOutcome>;
  onDiscoverModels: (profileId: string) => Promise<BackendDiscoveredModel[]>;
  onDelete: (profileId: string) => Promise<void>;
}

export function failureMessage(reason: unknown, fallback: string): string {
  const message = reason instanceof Error
    ? reason.message.replace(ELECTRON_IPC_ERROR_PREFIX, "").trim()
    : "";
  return message || fallback;
}

export interface ProbeProgress {
  tested: number;
  total: number;
}

export function probeProgressLabel({ tested, total }: ProbeProgress): string {
  return `Tested ${tested} of ${total} ${total === 1 ? "model" : "models"}…`;
}

export async function probeEveryModel(
  onProbe: BackendProfileActions["onProbe"],
  profile: Pick<ModelBackendProfileDetail, "id" | "models">,
  onProgress?: (progress: ProbeProgress) => void,
): Promise<ModelBackendProfileDetail> {
  const total = profile.models.length;
  let queue = profile.models.map(({ id }) => id);
  let tested = 0;
  let stalled = 0;
  let result: BackendProbeOutcome | null = null;
  let first = true;
  onProgress?.({ tested, total });
  while (queue.length > 0) {
    const batch = queue.slice(0, MAX_BACKEND_PROBE_MODELS);
    result = first && queue.length <= MAX_BACKEND_PROBE_MODELS
      ? await onProbe(profile.id)
      : await onProbe(profile.id, batch);
    first = false;
    const skipped = (result.skippedModelIds ?? []).filter((id) => batch.includes(id));
    tested += batch.length - skipped.length;
    queue = [...skipped, ...queue.slice(batch.length)];
    onProgress?.({ tested, total });
    stalled = skipped.length === batch.length ? stalled + 1 : 0;
    if (stalled >= 2) {
      throw new Error(`The backend did not answer in time. ${probeProgressLabel({ tested, total }).replace("…", ".")}`);
    }
  }
  const { skippedModelIds: _skipped, ...detail } = result!;
  return detail;
}
