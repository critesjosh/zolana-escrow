// Node-only fundraiser helpers for the localnet test: env config, proving-key
// file reads and the Node WASM build. Browser-safe helpers live in core.ts.

import { readFileSync } from "node:fs";

import type { ZolanaClientConfig } from "@heliuslabs/zolana";
import { address, type Address } from "@solana/kit";

import type { ProgramProof, ProgramTransaction } from "./wasm-types.js";
import { wasm } from "./wasm.js";

export * from "./core.js";

const PROVING_KEYS = new URL("../../../target/zk/private-fundraiser-program/", import.meta.url);

export type Circuit = "contribute" | "refund" | "settle1" | "settle2" | "settle3" | "settle4";

const PROVERS = {
  contribute: wasm.ContributeProver,
  refund: wasm.RefundProver,
  settle1: wasm.Settle1Prover,
  settle2: wasm.Settle2Prover,
  settle3: wasm.Settle3Prover,
  settle4: wasm.Settle4Prover,
} as const;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`the private fundraiser TypeScript test requires ${name}`);
  return value;
}

export function fundraiserProgramId(): Address {
  return address(requiredEnv("PRIVATE_FUNDRAISER_PROGRAM_ID"));
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

/** Proves a program transaction in-process with the circuit's WASM prover. */
export function prove(circuit: Circuit, transaction: ProgramTransaction): ProgramProof {
  const key = readFileSync(new URL(`${circuit}.pk`, PROVING_KEYS));
  const prover = PROVERS[circuit].fromKey(key);
  try {
    return prover.prove(transaction.proofInputs);
  } finally {
    prover.free();
  }
}
