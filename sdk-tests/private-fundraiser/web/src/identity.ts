// Disposable localnet identities, one random Ed25519 seed per role in
// localStorage, plus the coordinator's preimage store. Nothing here holds real
// funds, and the app never imports a user's wallet seed.

export const ROLES = ["coordinator", "alice", "bob", "beneficiary"] as const;
export type Role = (typeof ROLES)[number];
export const CONTRIBUTORS = ["alice", "bob"] as const satisfies readonly Role[];
export type Contributor = (typeof CONTRIBUTORS)[number];

const PREFIX = "private-fundraiser-web:localnet-only";
const seedKey = (role: Role) => `${PREFIX}:seed:${role}`;
const CAMPAIGNS_KEY = `${PREFIX}:campaigns`;
const STORE_KEY = `${PREFIX}:coordinator-store`;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array | undefined {
  if (!/^[0-9a-f]{64}$/u.test(text)) return undefined;
  return Uint8Array.from(text.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** The role's stored seed, or a new one saved for the next load. */
export function loadOrCreateSeed(role: Role, storage: Storage = localStorage): Uint8Array {
  const stored = fromHex(storage.getItem(seedKey(role)) ?? "");
  if (stored !== undefined) return stored;
  const seed = crypto.getRandomValues(new Uint8Array(32));
  storage.setItem(seedKey(role), toHex(seed));
  return seed;
}

/** Forgets every identity, campaign and the coordinator's store. */
export function forgetAll(storage: Storage = localStorage): void {
  for (const role of ROLES) storage.removeItem(seedKey(role));
  storage.removeItem(CAMPAIGNS_KEY);
  storage.removeItem(STORE_KEY);
}

export function loadCampaigns(storage: Storage = localStorage): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CAMPAIGNS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function saveCampaign(address: string, storage: Storage = localStorage): void {
  const campaigns = loadCampaigns(storage);
  if (!campaigns.includes(address))
    storage.setItem(CAMPAIGNS_KEY, JSON.stringify([address, ...campaigns]));
}

/** The coordinator's store, encoded by `encodeStore` in model.ts. */
export function loadStoreText(storage: Storage = localStorage): string {
  return storage.getItem(STORE_KEY) ?? "[]";
}

export function saveStoreText(text: string, storage: Storage = localStorage): void {
  storage.setItem(STORE_KEY, text);
}

export function forgetStore(storage: Storage = localStorage): void {
  storage.removeItem(STORE_KEY);
}
