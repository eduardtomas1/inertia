import { z } from "zod";

import {
  MAX_LIBRARY_IDENTIFIER_CHARS,
  libraryCategoryNameSchema,
  savedAnswerTitleSchema,
} from "../../library";
import { requestBase } from "./common";

const identifierSchema = z.string().min(1).max(MAX_LIBRARY_IDENTIFIER_CHARS);

export const libraryCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("library.category.create"),
    payload: z.object({ name: libraryCategoryNameSchema }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("library.category.rename"),
    payload: z.object({ categoryId: z.string().uuid(), name: libraryCategoryNameSchema }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("library.category.delete"),
    payload: z.object({ categoryId: z.string().uuid() }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("library.answer.save"),
    payload: z.object({
      conversationId: identifierSchema,
      turnId: identifierSchema,
      messageId: identifierSchema,
      categoryId: z.string().uuid().nullable(),
      title: savedAnswerTitleSchema.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("library.answer.update"),
    payload: z.object({
      savedAnswerId: z.string().uuid(),
      categoryId: z.string().uuid().nullable().optional(),
      title: savedAnswerTitleSchema.optional(),
    }).strict().refine(
      (payload) => payload.categoryId !== undefined || payload.title !== undefined,
      "A saved answer update must change at least one field.",
    ),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("library.answer.remove"),
    payload: z.object({ savedAnswerId: z.string().uuid() }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("library.pages.list"),
    payload: z.object({}).strict(),
  }).strict(),
] as const;
