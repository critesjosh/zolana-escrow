import {
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { describe, expect, it } from "vitest";

import { campaignPhase, type Campaign } from "../../../typescript/core.js";
import {
  forgetAll,
  loadCampaigns,
  loadOrCreateSeed,
  saveCampaign,
  saveStoreText,
  loadStoreText,
} from "../../src/identity.js";
import {
  decodeStore,
  describeError,
  encodeStore,
  formatSol,
  parseSeconds,
  parseSol,
  secondsUntil,
  stageStates,
} from "../../src/model.js";

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  clear(): void {
    this.#items.clear();
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}

function programError(code: number): Error {
  const custom = new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code, index: 0 });
  return new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    cause: custom,
    unitsConsumed: 0n,
  } as never);
}

describe("stageStates", () => {
  it("puts the coordinator check between the proofs and the submission", () => {
    expect(
      stageStates("contribute", "coordinatorCheck").map(({ stage, state }) => [stage, state]),
    ).toEqual([
      ["preparing", "done"],
      ["provingProgram", "done"],
      ["provingSpp", "done"],
      ["coordinatorCheck", "active"],
      ["submitting", "pending"],
      ["confirming", "pending"],
      ["syncing", "pending"],
    ]);
  });

  it("marks the stage that failed", () => {
    expect(stageStates("settle", "submitting", true)[4]).toMatchObject({
      stage: "submitting",
      state: "failed",
    });
  });

  it("refuses a stage outside the flow", () => {
    expect(() => stageStates("fund", "provingSpp")).toThrow(/not part of the fund flow/);
  });
});

describe("campaignPhase", () => {
  const campaign = { settled: false, closeTs: 100n, settleDeadline: 200n } as Campaign;

  it("uses the program's boundaries: close and deadline are the first instants of the next phase", () => {
    expect(campaignPhase(campaign, 99n)).toBe("open");
    expect(campaignPhase(campaign, 100n)).toBe("settling");
    expect(campaignPhase(campaign, 199n)).toBe("settling");
    expect(campaignPhase(campaign, 200n)).toBe("refunding");
  });

  it("reports a settled campaign as settled at any time", () => {
    expect(campaignPhase({ ...campaign, settled: true }, 50n)).toBe("settled");
    expect(campaignPhase({ ...campaign, settled: true }, 500n)).toBe("settled");
  });

  it("counts down to a boundary", () => {
    expect(secondsUntil(100n, 90n)).toBe(10n);
    expect(secondsUntil(100n, 100n)).toBe(0n);
  });
});

describe("amounts and inputs", () => {
  it("parses and formats SOL", () => {
    expect(parseSol("0.25")).toBe(250_000_000n);
    expect(formatSol(1_250_000_000n)).toBe("1.25 SOL");
    expect(() => parseSol("0")).toThrow(/more than zero/);
    expect(() => parseSol("1.0000000001")).toThrow(/SOL amount/);
  });

  it("parses windows in whole seconds", () => {
    expect(parseSeconds(" 90 ", "window")).toBe(90n);
    expect(() => parseSeconds("0", "window")).toThrow(/whole seconds/);
    expect(() => parseSeconds("1.5", "window")).toThrow(/whole seconds/);
  });
});

describe("describeError", () => {
  it("names a fundraiser program error and its code", () => {
    expect(describeError(programError(9112))).toBe(
      "Rejected by the fundraiser program: Settlement opens when contributions close. (error 9112)",
    );
    expect(describeError(programError(9108))).toContain("coordinator");
  });

  it("passes other errors through", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(programError(1))).not.toContain("fundraiser program");
  });
});

describe("coordinator store encoding", () => {
  it("round-trips bigints and byte arrays, which plain JSON loses", () => {
    const value = [{ amount: 5n, blinding: Uint8Array.of(1, 2, 3), nested: { id: 2n } }];
    const decoded = decodeStore<typeof value>(encodeStore(value));
    expect(decoded).toEqual(value);
    expect(decoded[0]?.blinding).toBeInstanceOf(Uint8Array);
  });
});

describe("identities", () => {
  it("keeps one seed per role across loads and forgets them all together", () => {
    const storage = new MemoryStorage();
    const coordinator = loadOrCreateSeed("coordinator", storage);
    expect(loadOrCreateSeed("coordinator", storage)).toEqual(coordinator);
    expect(loadOrCreateSeed("alice", storage)).not.toEqual(coordinator);
    saveCampaign("Campaign1", storage);
    saveCampaign("Campaign1", storage);
    saveStoreText("[1]", storage);
    expect(loadCampaigns(storage)).toEqual(["Campaign1"]);
    forgetAll(storage);
    expect(storage.length).toBe(0);
    expect(loadStoreText(storage)).toBe("[]");
  });

  it("ignores a corrupted campaign list", () => {
    const storage = new MemoryStorage();
    storage.setItem("private-fundraiser-web:localnet-only:campaigns", "not json");
    expect(loadCampaigns(storage)).toEqual([]);
  });
});
