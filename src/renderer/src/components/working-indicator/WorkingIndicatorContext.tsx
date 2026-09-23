import { createContext, useContext, useMemo } from "react";
import {
  DEFAULT_WORKING_INDICATOR,
  parseWorkingIndicatorSettings,
  type WorkingIndicatorSettings,
} from "@shared/working-indicator";

const WorkingIndicatorContext = createContext<Readonly<WorkingIndicatorSettings>>(
  DEFAULT_WORKING_INDICATOR,
);

export function WorkingIndicatorProvider({
  settings,
  children,
}: {
  settings: unknown;
  children: React.ReactNode;
}): React.JSX.Element {
  const serialized = JSON.stringify(settings ?? null);
  const value = useMemo(
    () => parseWorkingIndicatorSettings(JSON.parse(serialized)),
    [serialized],
  );
  return (
    <WorkingIndicatorContext.Provider value={value}>
      {children}
    </WorkingIndicatorContext.Provider>
  );
}

export function useWorkingIndicator(): Readonly<WorkingIndicatorSettings> {
  return useContext(WorkingIndicatorContext);
}
