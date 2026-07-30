import { MESSAGE_SEND_PREPARATION_TIMEOUT_MS } from "../../../shared/runtime-command-timeouts";
import { RuntimeRequestError } from "../../runtime-errors";

const TIMEOUT_MESSAGE =
  "Preparing this message took too long. No turn was started.";

export class MessageSendPreparationTimeoutError
  extends RuntimeRequestError {}

export function messageSendPreparationDeadline(
  now = Date.now(),
): number {
  return now + MESSAGE_SEND_PREPARATION_TIMEOUT_MS;
}

export function messageSendPreparationExpired(
  deadlineAt: number,
  now = Date.now(),
): boolean {
  return now >= deadlineAt;
}

export function assertMessageSendPreparationPending(
  deadlineAt: number,
  now = Date.now(),
): void {
  if (messageSendPreparationExpired(deadlineAt, now)) {
    throw new MessageSendPreparationTimeoutError(TIMEOUT_MESSAGE);
  }
}

export function awaitMessageSendPreparation<T>(
  operation: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(
      new MessageSendPreparationTimeoutError(TIMEOUT_MESSAGE),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new MessageSendPreparationTimeoutError(TIMEOUT_MESSAGE));
    }, remainingMs);
    timer.unref();
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
