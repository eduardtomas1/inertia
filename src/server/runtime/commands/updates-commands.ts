import { RuntimeRequestError } from "../../runtime-errors";
import { defineRuntimeCommandHandler, type RuntimeCommandHandler } from "./command-router";

export function createUpdatesCommandHandler(): RuntimeCommandHandler {
  return defineRuntimeCommandHandler(["updates.run", "updates.finish"], async () => {
    throw new RuntimeRequestError("Inertia cannot update everything yet.");
  });
}
