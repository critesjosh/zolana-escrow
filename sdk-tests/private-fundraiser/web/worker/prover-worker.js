// Proves the fundraiser circuits off the main thread with the multi-threaded
// fundraiser WASM build. Served unbundled at /worker/ (see vite.config.ts).
import init, * as wasm from "/fundraiser-wasm/private_fundraiser_program.js";

const PROVERS = {
  contribute: wasm.ContributeProver,
  refund: wasm.RefundProver,
  settle1: wasm.Settle1Prover,
  settle2: wasm.Settle2Prover,
  settle3: wasm.Settle3Prover,
  settle4: wasm.Settle4Prover,
};

const ready = (async () => {
  await init();
  await wasm.initProverThreads(navigator.hardwareConcurrency);
})();
const provers = new Map();

function prover(circuit) {
  if (!(circuit in PROVERS)) return Promise.reject(new Error(`unknown circuit ${circuit}`));
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
