import { z } from "zod";

import {
  appUnderTestConversationPayloadSchema,
  appUnderTestLaunchPayloadSchema,
  appUnderTestLogReadPayloadSchema,
  appUnderTestStopPayloadSchema,
} from "../../app-under-test";
import { requestBase } from "./common";

/** The App surface's commands. Each is scoped to one chat's App session. */
export const appUnderTestCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("app-under-test.launches.list"),
    payload: appUnderTestConversationPayloadSchema,
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("app-under-test.launch"),
    payload: appUnderTestLaunchPayloadSchema,
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("app-under-test.stop"),
    payload: appUnderTestStopPayloadSchema,
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("app-under-test.logs.read"),
    payload: appUnderTestLogReadPayloadSchema,
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("app-under-test.evidence.list"),
    payload: appUnderTestConversationPayloadSchema,
  }).strict(),
] as const;
