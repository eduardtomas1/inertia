import { z } from "zod";

import { MAX_BACKEND_CREDENTIAL_LENGTH } from "./backend-credentials";

export const SECRET_REQUEST_STATUSES = ["pending", "saved", "declined", "ended", "expired", "revoked"] as const;
export type SecretRequestStatus = (typeof SECRET_REQUEST_STATUSES)[number];

export const SECRET_REQUEST_STORAGES = ["keychain", "memory"] as const;
export type SecretRequestStorage = (typeof SECRET_REQUEST_STORAGES)[number];

export const SECRET_REQUEST_MAX_TITLE_LENGTH = 80;
export const SECRET_REQUEST_MAX_DESCRIPTION_LENGTH = 600;
export const SECRET_REQUEST_MIN_TTL_HOURS = 1;
export const SECRET_REQUEST_MAX_TTL_HOURS = 24;
export const SECRET_REQUEST_MAX_ACTIVE = 32;
export const AGENT_SECRET_MIN_LENGTH = 4;
export const AGENT_SECRET_MAX_LENGTH = MAX_BACKEND_CREDENTIAL_LENGTH;

export interface SecretRequestReference {
  requestId: string;
  title: string;
  description: string;
  ttlHours: number;
  status: SecretRequestStatus;
  answeredAt: string | null;
  expiresAt: string | null;
  storage: SecretRequestStorage | null;
}

const TITLE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const DESCRIPTION_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

export function secretRequestCodePoints(value: string): number {
  return Array.from(value).length;
}

export function isSecretRequestTitle(value: unknown): value is string {
  return typeof value === "string"
    && secretRequestCodePoints(value) >= 1
    && secretRequestCodePoints(value) <= SECRET_REQUEST_MAX_TITLE_LENGTH
    && value.trim() === value
    && !TITLE_CONTROL.test(value);
}

export function isSecretRequestDescription(value: unknown): value is string {
  return typeof value === "string"
    && secretRequestCodePoints(value) >= 1
    && secretRequestCodePoints(value) <= SECRET_REQUEST_MAX_DESCRIPTION_LENGTH
    && value.trim() === value
    && !value.includes("\n\n\n")
    && !DESCRIPTION_CONTROL.test(value);
}

export function isSecretRequestTtlHours(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= SECRET_REQUEST_MIN_TTL_HOURS
    && value <= SECRET_REQUEST_MAX_TTL_HOURS;
}

const timestampSchema = z.string().datetime({ offset: true });

export const secretRequestReferenceSchema = z.strictObject({
  requestId: z.string().uuid(),
  title: z.string().refine(isSecretRequestTitle),
  description: z.string().refine(isSecretRequestDescription),
  ttlHours: z.number().refine(isSecretRequestTtlHours),
  status: z.enum(SECRET_REQUEST_STATUSES),
  answeredAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  storage: z.enum(SECRET_REQUEST_STORAGES).nullable(),
}).refine(({ status, answeredAt, expiresAt, storage }) => {
  switch (status) {
    case "pending":
      return answeredAt === null && expiresAt === null && storage === null;
    case "saved":
    case "expired":
    case "revoked":
      return answeredAt !== null && expiresAt !== null && storage !== null;
    case "declined":
    case "ended":
      return expiresAt === null && storage === null;
  }
});

export function isSecretRequestReference(value: unknown): value is SecretRequestReference {
  return secretRequestReferenceSchema.safeParse(value).success;
}

export interface SaveAgentSecretRequest {
  conversationId: string;
  requestId: string;
  secret: string;
}

export interface SaveAgentSecretResult {
  status: "saved";
  expiresAt: string;
  storage: SecretRequestStorage;
}
