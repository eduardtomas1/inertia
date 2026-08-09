export const PRIVATE_CONNECT_IPC = {
  getState: "inertia:private-connect-state",
  stateChanged: "inertia:private-connect-state-changed",
  setEnabled: "inertia:private-connect-set-enabled",
  createInvitation: "inertia:private-connect-create-invitation",
  approvePairing: "inertia:private-connect-approve-pairing",
  denyPairing: "inertia:private-connect-deny-pairing",
  revokeDevice: "inertia:private-connect-revoke-device",
  updateDevice: "inertia:private-connect-update-device",
} as const;
