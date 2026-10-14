// Proves the escrow and withdraw circuits off the main thread with the
// multi-threaded escrow WASM build. Served unbundled at /worker/ (see vite.config.ts).
import init, * as wasm from "/escrow-wasm/timelock_escrow_program.js";

const PROVERS = { escrow: wasm.EscrowProver, withdraw: wasm.WithdrawProver };

const ready = (async () => {
  await init();
  await wasm.initProverThreads(navigator.hardwareConcurrency);
})();
const provers = new Map();

function prover(circuit) {
  if (!provers.has(circuit)) {
    const loading = fetch(`/keys/${circuit}.pk`)
      .then((response) => {
        if (!response.ok) throw new Error(`${circuit} proving key: HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => PROVERS[circuit].fromKey(new Uint8Array(bytes)));
    loading.catch(() => provers.delete(circuit));
    provers.set(circuit, loading);
  }
  return provers.get(circuit);
}

self.addEventListener("message", async ({ data }) => {
  try {
    await ready;
    const started = performance.now();
    const proof = (await prover(data.circuit)).prove(data.proofInputs);
    self.postMessage({ id: data.id, proof, ms: performance.now() - started });
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
