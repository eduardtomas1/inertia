import { z } from "zod";

const label = z.string().min(1).max(200);
const identity = z.string().min(1).max(256);
const timestamp = z.iso.datetime().nullable();
export const usageSourceSchema = z.strictObject({
  id: z.string().uuid(), label, url: z.string().max(2048), enabled: z.boolean(),
});
export type UsageSource = z.infer<typeof usageSourceSchema>;
export const usageSourceProfileId = (id: string): string => `usage-source:${id}`;

/** An explicit origin, never an arbitrary management path or URL with credentials. */
export function usageSourceOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : null;
  } catch { return null; }
}
export const usageSourceInputSchema = usageSourceSchema.extend({
  url: z.string().max(2048).refine((value) => usageSourceOrigin(value) !== null,
    "Use an HTTPS origin, or HTTP on localhost, without a path, query, or credentials."),
});
export const usageWindowSchema = z.strictObject({
  id: identity, label, remainingPercent: z.number().min(0).max(100).nullable(),
  windowMinutes: z.number().positive().max(525600).nullable(), resetsAt: timestamp,
});
export const usageAccountSchema = z.strictObject({
  id: identity, providerId: label, providerLabel: label, label,
  email: z.string().max(256).nullable(), plan: label.nullable(),
  /** Opaque provider account identity, never inferred from email or plan. */
  identityKey: identity.nullable(), sources: z.array(label).max(8),
  status: z.enum(["ready", "stale", "error", "unsupported", "unavailable", "disabled"]),
  detail: z.string().max(500).nullable(), updatedAt: timestamp, checkedAt: timestamp,
  windows: z.array(usageWindowSchema).max(32),
  credits: z.strictObject({ availableCount: z.number().int().nonnegative().max(100000),
    nextCreditId: identity.nullable(), expiresAt: timestamp }).nullable(),
  canReset: z.boolean(),
  pendingReset: z.boolean().optional(),
});
export type UsageAccount = z.infer<typeof usageAccountSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;
export const usageLimitsSnapshotSchema = z.strictObject({
  accounts: z.array(usageAccountSchema).max(256),
  sources: z.array(usageSourceSchema.extend({ error: z.string().max(500).nullable() })).max(4),
  checkedAt: timestamp,
});
export type UsageLimitsSnapshot = z.infer<typeof usageLimitsSnapshotSchema>;
export const usageResetConfirmationSchema = z.strictObject({
  id: z.string().uuid(), accountId: identity, accountKey: identity, accountLabel: label,
  email: z.string().max(256).nullable(), plan: label.nullable(), creditId: identity.nullable(),
  expiresAt: z.iso.datetime(),
});
export type UsageResetConfirmation = z.infer<typeof usageResetConfirmationSchema>;
export const usageResetOutcomeSchema = z.enum(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"]);
export type UsageResetOutcome = z.infer<typeof usageResetOutcomeSchema>;
