/**
 * Compatibility entrypoint for runtime and test consumers. Migration
 * implementation lives with the persistence subsystem.
 */
export * from "./persistence/migrations/runner";
