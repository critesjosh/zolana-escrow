// App state helpers: progress stages, campaign phases, amounts, errors and the
// coordinator store encoding. No browser APIs, so the unit tests run them in Node.

import {
  customErrorCode,
  fundraiserErrorMessage,
  type CampaignPhase,
} from "../../typescript/core.js";

export { customErrorCode };

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** The stages the app can observe. Only the ones a flow actually reaches are shown. */
export const STAGES = {
  airdropping: "Airdropping localnet SOL",
  collecting: "Collecting accepted contributions (coordinator store + indexer)",
  discovering: "Discovering your contribution (indexer + viewing key)",
  preparing: "Preparing the transaction (WASM)",
  provingProgram: "Proving the fundraiser rules (browser worker)",
  provingSpp: "Proving the SPP transfer (local prover)",
  coordinatorCheck: "Coordinator checks the preimage and co-signs",
  submitting: "Submitting",
  confirming: "Confirming",
  syncing: "Syncing from the indexer",
} as const;

export type Stage = keyof typeof STAGES;

const TRANSACT = ["preparing", "provingProgram", "provingSpp"] as const;
const SEND = ["submitting", "confirming", "syncing"] as const;

export const FLOW_STAGES = {
  fund: ["airdropping", ...SEND],
  create: SEND,
  contribute: [...TRANSACT, "coordinatorCheck", ...SEND],
  settle: ["collecting", ...TRANSACT, ...SEND],
  refund: ["discovering", ...TRANSACT, ...SEND],
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

export const PHASE_LABELS: Readonly<Record<CampaignPhase, string>> = {
  open: "Open for contributions",
  settling: "Closed; waiting for settlement",
  settled: "Settled: paid to the beneficiary",
  refunding: "Failed: contributors can refund",
};

/** Seconds until `timestamp` on the chain clock, or 0 once reached. */
export function secondsUntil(timestamp: bigint, chainNow: bigint): bigint {
  return chainNow >= timestamp ? 0n : timestamp - chainNow;
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

export function parseSeconds(input: string, name: string): bigint {
  const text = input.trim();
  if (!/^\d+$/u.test(text) || BigInt(text) === 0n)
    throw new Error(`enter the ${name} in whole seconds`);
  return BigInt(text);
}

export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/u, "");
  return fraction === "" ? `${whole} SOL` : `${whole}.${fraction} SOL`;
}

export function describeError(error: unknown): string {
  const code = customErrorCode(error);
  const message = fundraiserErrorMessage(code);
  if (message !== undefined)
    return `Rejected by the fundraiser program: ${message} (error ${code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

// The coordinator store holds SDK values with bigints and byte arrays, which
// JSON cannot carry. Tag them so they decode to the same types.
export function encodeStore(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return { $bigint: item.toString() };
    if (item instanceof Uint8Array) return { $bytes: Array.from(item) };
    return item;
  });
}

export function decodeStore<T>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (typeof item === "object" && item !== null) {
      if ("$bigint" in item && typeof item.$bigint === "string") return BigInt(item.$bigint);
      if ("$bytes" in item && Array.isArray(item.$bytes)) return Uint8Array.from(item.$bytes);
    }
    return item;
  }) as T;
}
