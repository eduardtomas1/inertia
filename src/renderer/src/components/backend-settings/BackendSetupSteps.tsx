import { Check, CircleAlert, CircleDot } from "lucide-react";
import clsx from "clsx";

import { LoadingMark } from "../ui";
import type { BackendSetupStep } from "./useBackendSetup";

const STATE_TEXT: Readonly<Record<BackendSetupStep["state"], string>> = {
  pending: "Waiting",
  running: "In progress",
  done: "Done",
  failed: "Failed",
};

export function BackendSetupSteps({
  steps,
  label,
}: {
  steps: readonly BackendSetupStep[];
  label: string;
}): React.JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <ol className="backend-setup-steps" aria-label={label}>
      {steps.map((step) => {
        const Icon = step.state === "done"
          ? Check
          : step.state === "failed"
            ? CircleAlert
            : step.state === "running"
              ? LoadingMark
              : CircleDot;
        return (
          <li key={step.id} className={clsx("backend-setup-step", `is-${step.state}`)}>
            <Icon size={14} aria-hidden="true" />
            <span>{step.label}</span>
            <small>{step.state === "running" && step.detail ? step.detail : STATE_TEXT[step.state]}</small>
          </li>
        );
      })}
    </ol>
  );
}
