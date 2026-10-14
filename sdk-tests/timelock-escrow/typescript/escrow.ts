// Node-only escrow helpers for the localnet test: env config, proving-key file
// reads and the Node WASM build. Browser-safe helpers live in core.ts.

import { readFileSync } from "node:fs";

import type { ZolanaClientConfig } from "@heliuslabs/zolana";
import type { ViewingKey } from "@heliuslabs/zolana/keypair";
import type {
  AssetRegistry,
  IndexedShieldedTransaction,
  ProgramOwner,
} from "@heliuslabs/zolana/transaction";
import { address, type Address } from "@solana/kit";

import { escrowUtxos as findEscrowUtxos } from "./core.js";
import type { Timings } from "./timings.js";
import type { DataUtxo, EscrowTerms, ProgramProof, ProgramTransaction } from "./wasm-types.js";
import { wasm } from "./wasm.js";

export {
  ESCROW_OUTPUT_SLOT,
  NOT_YET_UNLOCKED,
  airdrop,
  chainUnixTimestamp,
  creatorTransactions,
  customErrorCode,
  escrowAuthority,
  escrowInstruction,
  randomKeypair,
  sendAndConfirmFactory,
  spendableSol,
  withdrawInstruction,
} from "./core.js";

const PROVING_KEYS = new URL("../../../target/zk/timelock-escrow-program/", import.meta.url);

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`the timelock escrow TypeScript test requires ${name}`);
  return value;
}

export function escrowProgramId(): Address {
  return address(requiredEnv("TIMELOCK_ESCROW_PROGRAM_ID"));
}

export function clientConfig(): ZolanaClientConfig {
  const solanaRpcUrl = process.env["ZOLANA_LOCALNET_URL"];
  const indexerUrl = process.env["ZOLANA_INDEXER_URL"];
  const proverUrl = process.env["ZOLANA_PROVER_URL"];
  return Object.freeze({
    ...(solanaRpcUrl === undefined ? {} : { solanaRpcUrl }),
    ...(indexerUrl === undefined ? {} : { indexerUrl }),
    ...(proverUrl === undefined ? {} : { proverUrl }),
  });
}

export function escrowUtxos(
  timings: Timings,
  viewingKey: ViewingKey,
  transactions: readonly IndexedShieldedTransaction[],
  authority: ProgramOwner,
  assets: AssetRegistry,
  treeId: number,
): readonly DataUtxo<EscrowTerms>[] {
  return findEscrowUtxos(
    (utxo) => timings.measure("escrowTermsDataUtxo", () => wasm.escrowTermsDataUtxo(utxo)),
    viewingKey,
    transactions,
    authority,
    assets,
    treeId,
  );
}

export function prove(
  timings: Timings,
  circuit: "escrow" | "withdraw",
  transaction: ProgramTransaction,
): ProgramProof {
  const key = timings.measure(`${circuit} read proving key`, () =>
    readFileSync(new URL(`${circuit}.pk`, PROVING_KEYS)),
  );
  const prover = timings.measure(`${circuit} prover fromKey`, () =>
    circuit === "escrow" ? wasm.EscrowProver.fromKey(key) : wasm.WithdrawProver.fromKey(key),
  );
  try {
    return timings.measure(`${circuit} prove`, () => prover.prove(transaction.proofInputs));
  } finally {
    prover.free();
  }
}
