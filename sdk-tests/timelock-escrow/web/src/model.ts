// App state helpers: progress stages, escrow status, amounts and errors. No
// browser APIs, so the unit tests run them in Node.

import { NOT_YET_UNLOCKED, customErrorCode } from "../../typescript/core.js";

export { customErrorCode };

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** The stages the app can observe. Only the ones a flow actually reaches are shown. */
export const STAGES = {
  airdropping: "Airdropping localnet SOL",
  preparing: "Preparing the transaction (WASM)",
  provingProgram: "Proving the escrow rules (browser worker)",
  provingSpp: "Proving the SPP transfer (local prover)",
  submitting: "Submitting",
  confirming: "Confirming",
  syncing: "Syncing from the indexer",
} as const;

export type Stage = keyof typeof STAGES;

export const FLOW_STAGES = {
  fund: ["airdropping", "submitting", "confirming", "syncing"],
  lock: ["preparing", "provingProgram", "provingSpp", "submitting", "confirming", "syncing"],
  withdraw: ["preparing", "provingProgram", "provingSpp", "submitting", "confirming", "syncing"],
} as const satisfies Record<string, readonly Stage[]>;

export type Flow = keyof typeof FLOW_STAGES;

export type StageState = "pending" | "active" | "done" | "failed";

function stateAt(position: number, current: number, failed: boolean): StageState {
  if (position < current) return "done";
  if (position > current) return "pending";
  return failed ? "failed" : "active";
}

/** Each stage of `flow` with its state, given the current stage and whether the flow failed. */
export function stageStates(
  flow: Flow,
  current: Stage | "done",
  failed = false,
): readonly { stage: Stage; label: string; state: StageState }[] {
  const stages: readonly Stage[] = FLOW_STAGES[flow];
  const index = current === "done" ? stages.length : stages.indexOf(current);
  if (index < 0) throw new Error(`stage ${current} is not part of the ${flow} flow`);
  return stages.map((stage, i) => ({
    stage,
    label: STAGES[stage],
    state: stateAt(i, index, failed),
  }));
}

export type EscrowStatus = "locked" | "unlocked";

/** The program accepts a withdraw only when the Clock is strictly past unlock. */
export function escrowStatus(unlock: bigint, chainNow: bigint): EscrowStatus {
  return chainNow > unlock ? "unlocked" : "locked";
}

export function secondsUntilUnlock(unlock: bigint, chainNow: bigint): bigint {
  return chainNow > unlock ? 0n : unlock - chainNow + 1n;
}

/** Parses a SOL amount with up to nine decimals into lamports. */
export function parseSol(input: string): bigint {
  const match = /^\s*(\d+)(?:\.(\d{1,9}))?\s*$/u.exec(input);
  if (match === null) throw new Error("enter a SOL amount, for example 0.25");
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(9, "0"));
  const lamports = whole * LAMPORTS_PER_SOL + fraction;
  if (lamports === 0n) throw new Error("the amount must be more than zero");
  return lamports;
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/u, "");
  return fraction === "" ? `${whole} SOL` : `${whole}.${fraction} SOL`;
}

export function describeError(error: unknown): string {
  if (customErrorCode(error) === NOT_YET_UNLOCKED)
    return "Rejected by the escrow program: not yet unlocked (error 9005). The on-chain clock must pass the unlock time.";
  if (error instanceof Error) return error.message;
  return String(error);
}
