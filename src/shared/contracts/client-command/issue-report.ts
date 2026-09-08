import { z } from "zod";
import { requestBase } from "./common";
import { issueReportInputSchema, REPORT_BODY_LIMIT } from "../../issue-report";
const identity = { id: z.string().uuid(), revision: z.number().int().nonnegative() };
export const issueReportCommandSchemas = [
  z.object({ ...requestBase, type: z.literal("support.report.get") }),
  z.object({ ...requestBase, type: z.literal("support.report.prepare"), payload: issueReportInputSchema }),
  z.object({ ...requestBase, type: z.literal("support.report.validate"), payload: z.object(identity).strict() }),
  z.object({ ...requestBase, type: z.literal("support.report.cancel"), payload: z.object({ id: identity.id }).strict() }),
  z.object({ ...requestBase, type: z.literal("support.report.edit"), payload: z.object({ ...identity, title: z.string().trim().min(3).max(200), body: z.string().trim().min(10).max(REPORT_BODY_LIMIT) }).strict() }),
  z.object({ ...requestBase, type: z.literal("support.report.submit"), payload: z.object(identity).strict() }),
  z.object({ ...requestBase, type: z.literal("support.report.reconcile"), payload: z.object(identity).strict() }),
] as const;
