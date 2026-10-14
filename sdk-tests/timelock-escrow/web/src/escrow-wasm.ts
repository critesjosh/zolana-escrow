// The escrow WASM module on the main thread, for the cheap synchronous calls
// (proof inputs, escrow terms). Proving runs in the worker (prover.ts).

type WebModule =
  typeof import("../../../../target/zk/timelock-escrow-program/wasm/timelock_escrow_program.js");

// Loaded by URL, not bundled: see vite.config.ts.
const MODULE_URL = "/escrow-wasm/timelock_escrow_program.js";

let loading: Promise<WebModule> | undefined;

export function escrowWasm(): Promise<WebModule> {
  loading ??= (async () => {
    const module = (await import(/* @vite-ignore */ MODULE_URL)) as WebModule;
    await module.default();
    return module;
  })();
  return loading;
}
