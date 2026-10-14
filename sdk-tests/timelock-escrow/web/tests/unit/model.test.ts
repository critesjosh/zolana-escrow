import {
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import type { ProgramWalletUtxo } from "@heliuslabs/zolana/transaction";
import { describe, expect, it } from "vitest";

import { selectInputs } from "../../src/app.js";
import { forgetSeed, loadOrCreateSeed } from "../../src/identity.js";
import {
  customErrorCode,
  describeError,
  escrowStatus,
  formatSol,
  parseSol,
  secondsUntilUnlock,
  stageStates,
} from "../../src/model.js";

describe("stageStates", () => {
  it("marks earlier stages done, the current one active and later ones pending", () => {
    expect(stageStates("lock", "provingSpp").map(({ stage, state }) => [stage, state])).toEqual([
      ["preparing", "done"],
      ["provingProgram", "done"],
      ["provingSpp", "active"],
      ["submitting", "pending"],
      ["confirming", "pending"],
      ["syncing", "pending"],
    ]);
  });

  it("marks the stage that failed", () => {
    expect(stageStates("withdraw", "submitting", true)[3]).toMatchObject({ state: "failed" });
  });

  it("marks every stage done once the flow finishes", () => {
    expect(stageStates("fund", "done").every(({ state }) => state === "done")).toBe(true);
  });

  it("refuses a stage the flow never reaches", () => {
    expect(() => stageStates("fund", "provingProgram")).toThrow(/not part of the fund flow/);
  });
});

describe("escrowStatus", () => {
  // The program requires now > unlock, so the unlock second itself is still locked.
  it("stays locked through the unlock second", () => {
    expect(escrowStatus(100n, 99n)).toBe("locked");
    expect(escrowStatus(100n, 100n)).toBe("locked");
    expect(escrowStatus(100n, 101n)).toBe("unlocked");
  });

  it("counts the seconds until a withdraw can succeed", () => {
    expect(secondsUntilUnlock(100n, 90n)).toBe(11n);
    expect(secondsUntilUnlock(100n, 100n)).toBe(1n);
    expect(secondsUntilUnlock(100n, 101n)).toBe(0n);
  });
});

describe("SOL amounts", () => {
  it("parses decimal SOL into lamports", () => {
    expect(parseSol("0.3")).toBe(300_000_000n);
    expect(parseSol(" 2 ")).toBe(2_000_000_000n);
    expect(parseSol("0.000000001")).toBe(1n);
  });

  it("rejects zero, negative, and over-precise amounts", () => {
    expect(() => parseSol("0")).toThrow(/more than zero/);
    expect(() => parseSol("-1")).toThrow(/SOL amount/);
    expect(() => parseSol("0.0000000001")).toThrow(/SOL amount/);
  });

  it("formats lamports without trailing zeros", () => {
    expect(formatSol(300_000_000n)).toBe("0.3 SOL");
    expect(formatSol(2_000_000_000n)).toBe("2 SOL");
  });
});

describe("error mapping", () => {
  const notYetUnlocked = new SolanaError(
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    {
      accounts: null,
      loadedAccountsDataSize: undefined,
      logs: null,
      returnData: null,
      unitsConsumed: undefined,
      cause: new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code: 9005, index: 0 }),
    } as never,
  );

  it("finds the program error code in the cause chain", () => {
    expect(customErrorCode(notYetUnlocked)).toBe(9005);
    expect(customErrorCode(new Error("other"))).toBeUndefined();
  });

  it("explains an early withdraw", () => {
    expect(describeError(notYetUnlocked)).toMatch(/not yet unlocked \(error 9005\)/);
    expect(describeError(new Error("boom"))).toBe("boom");
  });
});

describe("identity", () => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => void values.delete(key),
      setItem: (key, value) => void values.set(key, value),
    };
  }

  it("keeps one seed across loads until it is forgotten", () => {
    const storage = memoryStorage();
    const first = loadOrCreateSeed(storage);
    expect(first).toHaveLength(32);
    expect(loadOrCreateSeed(storage)).toEqual(first);
    forgetSeed(storage);
    expect(loadOrCreateSeed(storage)).not.toEqual(first);
  });
});

describe("selectInputs", () => {
  const utxo = (amount: bigint) => ({ utxo: { amount } }) as unknown as ProgramWalletUtxo;

  it("picks the largest UTXOs until the amount is covered", () => {
    const picked = selectInputs([utxo(1n), utxo(5n), utxo(3n)], 7n);
    expect(picked.map((input) => input.utxo.amount)).toEqual([5n, 3n]);
  });

  it("refuses when five UTXOs cannot cover the amount", () => {
    expect(() =>
      selectInputs(
        Array.from({ length: 6 }, () => utxo(1n)),
        6n,
      ),
    ).toThrow(/5 largest shielded UTXOs/);
  });
});
