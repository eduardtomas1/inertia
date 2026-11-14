export const AGENT_SECRET_REVOKE_ERRORS = Object.freeze({
  notActive: "That secret is no longer active.",
  inUse: "A program is still using this secret's file, so Inertia couldn't delete it. Close it and try again.",
});
