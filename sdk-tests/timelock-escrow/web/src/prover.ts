// Client for worker/prover-worker.js: escrow and withdraw proofs off the main thread.

import type { ProgramProof } from "../../typescript/wasm-types.js";

type Reply = { id: number; proof: ProgramProof; ms: number } | { id: number; error: string };

export class ProgramProver {
  readonly #worker = new Worker("/worker/prover-worker.js", { type: "module" });
  readonly #pending = new Map<number, (reply: Reply) => void>();
  #nextId = 0;

  constructor() {
    this.#worker.addEventListener("message", ({ data }: MessageEvent<Reply>) => {
      this.#pending.get(data.id)?.(data);
      this.#pending.delete(data.id);
    });
    // A worker that fails to load (for example, served without COEP) never replies.
    this.#worker.addEventListener("error", (event) => {
      const error = event.message || "the prover worker failed to load";
      for (const [id, settle] of this.#pending) settle({ id, error });
      this.#pending.clear();
    });
  }

  prove(
    circuit: "escrow" | "withdraw",
    proofInputs: Uint8Array,
  ): Promise<{ proof: ProgramProof; ms: number }> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (reply) =>
        "error" in reply ? reject(new Error(`${circuit} proof: ${reply.error}`)) : resolve(reply),
      );
      this.#worker.postMessage({ id, circuit, proofInputs });
    });
  }
}
