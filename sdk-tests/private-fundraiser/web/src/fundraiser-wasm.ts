// The fundraiser WASM module on the main thread, for the cheap synchronous
// calls (proof inputs, contribution terms). Proving runs in the worker.

type WebModule =
  typeof import("../../../../target/zk/private-fundraiser-program/wasm/private_fundraiser_program.js");

// Loaded by URL, not bundled: see vite.config.ts.
const MODULE_URL = "/fundraiser-wasm/private_fundraiser_program.js";

let loading: Promise<WebModule> | undefined;

export function fundraiserWasm(): Promise<WebModule> {
  loading ??= (async () => {
    const module = (await import(/* @vite-ignore */ MODULE_URL)) as WebModule;
    await module.default();
    return module;
  })();
  return loading;
}
