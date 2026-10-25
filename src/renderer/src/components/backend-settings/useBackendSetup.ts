import { useCallback, useEffect, useRef, useState } from "react";

import type {
  BackendDiscoveredModel,
  ModelBackendProfileCreateDraft,
  ModelBackendProfileDetail,
  ModelBackendProfileView,
} from "@shared/contracts";
import { mergeDiscoveredModels } from "../../utils/backendProfileDraft";
import { backendKeyCheckProblem } from "../../utils/backendSettingsModel";
import { failureMessage, type BackendProfileActions } from "./backendSettingsActions";

export type BackendSetupStepId = "create" | "key" | "models" | "test" | "enable";
export type BackendSetupStepState = "pending" | "running" | "done" | "failed";

export interface BackendSetupStep {
  id: BackendSetupStepId;
  label: string;
  state: BackendSetupStepState;
  detail?: string;
}

export interface BackendSetupInput {
  draft: () => ModelBackendProfileCreateDraft;
  secret: string | null;
  discover: boolean;
}

export type BackendSetupPhase = "idle" | "running" | "choose-models" | "failed" | "done";

export type BackendSetupStatus =
  | { state: "running" }
  | { state: "failed"; message: string }
  | { state: "done" };

export type BackendSetupStatusListener = (
  profile: ModelBackendProfileView,
  status: BackendSetupStatus,
) => void;

const STEP_LABELS: Readonly<Record<BackendSetupStepId, string>> = {
  create: "Save the route",
  key: "Store the key in your credential vault",
  models: "Find the models this key can use",
  test: "Check that the key works",
  enable: "Turn the route on",
};

interface SetupProgress {
  profile: ModelBackendProfileDetail | null;
  keyStored: boolean;
  modelsChosen: boolean;
}

function stepsFor(input: Pick<BackendSetupInput, "secret" | "discover">): BackendSetupStep[] {
  const ids: BackendSetupStepId[] = [
    "create",
    ...(input.secret !== null ? ["key" as const] : []),
    ...(input.discover ? ["models" as const] : []),
    "test",
    "enable",
  ];
  return ids.map((id) => ({ id, label: STEP_LABELS[id], state: "pending" }));
}

export function useBackendSetup(
  actions: Pick<
    BackendProfileActions,
    "onCreate" | "onSetCredential" | "onDiscoverModels" | "onUpdate" | "onProbe"
  >,
  onStatus?: BackendSetupStatusListener,
) {
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const report = useCallback((status: BackendSetupStatus) => {
    const current = progressRef.current.profile;
    if (current) statusRef.current?.(current, status);
  }, []);
  const [steps, setSteps] = useState<BackendSetupStep[]>([]);
  const [phase, setPhase] = useState<BackendSetupPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<BackendDiscoveredModel[] | null>(null);
  const [profile, setProfile] = useState<ModelBackendProfileDetail | null>(null);
  const [keyStores, setKeyStores] = useState(0);
  const progressRef = useRef<SetupProgress>({ profile: null, keyStored: false, modelsChosen: false });
  const inputRef = useRef<BackendSetupInput | null>(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const mark = useCallback((id: BackendSetupStepId, state: BackendSetupStepState) => {
    if (!mountedRef.current) return;
    setSteps((current) => current.map((step) => step.id === id ? { ...step, state } : step));
  }, []);

  const adopt = useCallback((value: ModelBackendProfileDetail) => {
    progressRef.current.profile = value;
    if (mountedRef.current) setProfile(value);
  }, []);

  const finishFrom = useCallback(async (
    start: BackendSetupStepId,
    input: BackendSetupInput,
  ): Promise<void> => {
    const order: BackendSetupStepId[] = ["create", "key", "models", "test", "enable"];
    const startIndex = order.indexOf(start);
    const progress = progressRef.current;
    let current: BackendSetupStepId = start;
    try {
      if (startIndex <= order.indexOf("create") && !progress.profile) {
        current = "create";
        mark("create", "running");
        adopt(await actions.onCreate(input.draft()));
      }
      report({ state: "running" });
      mark("create", "done");
      const profileId = progress.profile!.id;
      if (startIndex <= order.indexOf("key") && input.secret) {
        current = "key";
        mark("key", "running");
        const secret = input.secret;
        input.secret = "";
        adopt(await actions.onSetCredential(profileId, secret));
        progress.keyStored = true;
        if (mountedRef.current) setKeyStores((count) => count + 1);
      } else if (input.secret !== null && !progress.keyStored) {
        current = "key";
        throw new Error("Paste the API key to continue.");
      }
      if (input.secret !== null) mark("key", "done");
      if (input.discover && !progress.modelsChosen) {
        current = "models";
        mark("models", "running");
        const models = await actions.onDiscoverModels(profileId);
        if (!mountedRef.current) return;
        if (models.length === 0) {
          throw new Error("The endpoint did not list any models. Choose the default models instead.");
        }
        setDiscovered(models);
        setPhase("choose-models");
        return;
      }
      if (input.discover) mark("models", "done");
      current = "test";
      mark("test", "running");
      const tested = await actions.onProbe(profileId, []);
      adopt(tested);
      const problem = backendKeyCheckProblem(tested);
      if (problem) throw new Error(problem);
      mark("test", "done");
      current = "enable";
      mark("enable", "running");
      if (!tested.enabled) adopt(await actions.onUpdate(profileId, { enabled: true }));
      mark("enable", "done");
      report({ state: "done" });
      if (mountedRef.current) setPhase("done");
    } catch (reason) {
      mark(current, "failed");
      const message = failureMessage(reason, "This step could not be completed.");
      report({ state: "failed", message });
      if (!mountedRef.current) return;
      setError(message);
      setPhase("failed");
    }
  }, [actions, adopt, mark, report]);

  const run = useCallback(async (input: BackendSetupInput): Promise<void> => {
    if (runningRef.current) return;
    runningRef.current = true;
    inputRef.current = input;
    const progress = progressRef.current;
    setSteps((current) => {
      const next = stepsFor(input);
      return next.map((step) => {
        const previous = current.find(({ id }) => id === step.id);
        return previous?.state === "done"
          && (
            step.id === "create"
            || (step.id === "models" && progress.modelsChosen)
            || (step.id === "key" && progress.keyStored && !input.secret)
          )
          ? previous
          : step;
      });
    });
    setError(null);
    setPhase("running");
    try {
      await finishFrom("create", input);
    } finally {
      runningRef.current = false;
    }
  }, [finishFrom]);

  const chooseModels = useCallback(async (models: readonly BackendDiscoveredModel[]): Promise<void> => {
    const input = inputRef.current;
    const current = progressRef.current.profile;
    if (!input || !current || runningRef.current || models.length === 0) return;
    runningRef.current = true;
    setPhase("running");
    setError(null);
    mark("models", "running");
    try {
      const merged = mergeDiscoveredModels({ models: [], routing: current.routing }, models);
      adopt(await actions.onUpdate(current.id, { models: merged.models, routing: merged.routing }));
      progressRef.current.modelsChosen = true;
      setDiscovered(null);
      await finishFrom("test", input);
    } catch (reason) {
      mark("models", "failed");
      if (mountedRef.current) {
        setError(failureMessage(reason, "The models could not be saved."));
        setPhase("failed");
      }
    } finally {
      runningRef.current = false;
    }
  }, [actions, adopt, finishFrom, mark]);

  return { steps, phase, error, discovered, profile, keyStored: keyStores > 0, keyStores, run, chooseModels };
}
