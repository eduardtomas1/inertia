import {
  MESSAGE_ADMISSION_UNAVAILABLE, publicRuntimeError, RuntimeRequestError, userCorrectableRuntimeError,
} from "../../runtime-errors";
import { MessageSendPreparationTimeoutError } from "./message-send-preparation";

export function commandRejection(error: unknown): string | null {
  if (!(error instanceof RuntimeRequestError) || error instanceof MessageSendPreparationTimeoutError) return null;
  if (userCorrectableRuntimeError(error)) return null;
  if (error.delivery === "ambiguous" || error.code === MESSAGE_ADMISSION_UNAVAILABLE) return null;
  if (error.code?.endsWith("/unexpected")) return null;
  return publicRuntimeError(error);
}
