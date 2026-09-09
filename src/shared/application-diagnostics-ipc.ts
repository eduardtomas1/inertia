/** Dependency-free channel names for the sandboxed preload. */
export const DIAGNOSTICS_IPC = {
  query: "inertia:diagnostics-query",
  copy: "inertia:diagnostics-copy",
  export: "inertia:diagnostics-export",
  reportValidation: "inertia:diagnostics-validation",
  changed: "inertia:diagnostics-changed",
} as const;
