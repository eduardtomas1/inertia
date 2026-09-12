import { usageLimitsSnapshotSchema, usageResetConfirmationSchema, usageResetOutcomeSchema } from "../provider-usage-limits";
import { usageDashboardSchema } from "./usage-dashboard-schema";
import { dailyWorkDashboardSchema } from "./daily-work-schema";

export const usageResultValidators = {
  "usage.limits": (value: Record<string, unknown>) => usageLimitsSnapshotSchema.safeParse(value.snapshot).success,
  "usage.reset.confirmation": (value: Record<string, unknown>) => usageResetConfirmationSchema.safeParse(value.confirmation).success,
  "usage.reset.outcome": (value: Record<string, unknown>) => usageResetOutcomeSchema.safeParse(value.outcome).success,
  "usage.dashboard": (value: Record<string, unknown>) => usageDashboardSchema(value.dashboard),
  "daily.work": (value: Record<string, unknown>) => dailyWorkDashboardSchema(value.dashboard),
};
