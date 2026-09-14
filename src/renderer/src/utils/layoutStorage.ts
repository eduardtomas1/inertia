// Layout preferences are optional. Keep both the localStorage getter and its
// operations inside the guard: hardened sessions can reject either one.
// Durable drafts must use their existing persistence/acknowledgement paths.
export const layoutStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  setItem(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* Optional preference. */ }
  },
  removeItem(key) {
    try { window.localStorage.removeItem(key); } catch { /* Optional preference. */ }
  },
};
