// The disposable localnet identity: one random Ed25519 seed in localStorage.
// It never holds real funds and the app never imports a user's wallet seed.

const STORAGE_KEY = "timelock-escrow-web:localnet-only-seed";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/u.test(text)) return undefined;
  return Uint8Array.from(text.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** The stored seed, or a new one saved for the next load. */
export function loadOrCreateSeed(storage: Storage = localStorage): Uint8Array {
  const stored = fromHex(storage.getItem(STORAGE_KEY) ?? "");
  if (stored !== undefined) return stored;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  storage.setItem(STORAGE_KEY, toHex(seed));
  return seed;
}

export function forgetSeed(storage: Storage = localStorage): void {
  storage.removeItem(STORAGE_KEY);
}
