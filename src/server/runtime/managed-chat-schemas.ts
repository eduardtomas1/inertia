import { z } from "zod";

/**
 * Argument schemas the chat tools share. Each JSON Schema pattern accepts
 * exactly what its zod validator accepts, so a provider that checks the
 * advertised schema and Inertia agree.
 */
export const MAX_PROMPT_CHARS = 32_768;
export const SINGLE_LINE_PATTERN = "^[^\\S\\x00-\\x1f\\x7f]*[^\\s\\x00-\\x1f\\x7f][^\\x00-\\x1f\\x7f]*$";
export const MULTILINE_PATTERN = "^\\s*[^\\s\\x00][^\\x00]*$";
export const tokenPattern = (maximum: number) => `^[^\\s\\x00-\\x1f\\x7f]{1,${maximum}}$`;
export const idSchema = z.string().uuid();
export const safeSingleLineSchema = (maximum: number) => z.string()
  .max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "must be one line without control characters")
  .trim()
  .min(1);
export const safeMultilineSchema = (maximum: number) => z.string()
  .max(maximum)
  .refine((value) => !value.includes("\0"), "must not contain NUL characters")
  .trim()
  .min(1);
export const tokenSchema = (maximum: number) => z.string()
  .max(maximum)
  .regex(new RegExp(tokenPattern(maximum), "u"), "must be one word without spaces or control characters");
