# Private fundraiser web example

A localnet page that plays every role of the [private fundraiser](../README.md): the
coordinator, two contributors (Alice and Bob) and the beneficiary. Vanilla TypeScript and Vite,
built on [`../typescript/core.ts`](../typescript/core.ts) and the SDK, in the same order as the
TypeScript lifecycle test.

## Run

```bash
just fundraiser-web       # fresh localnet + dev server at http://127.0.0.1:5181
just check-fundraiser-web # format, lint, typecheck, unit tests (no localnet)
just test-fundraiser-web  # the flow in Chromium against a fresh localnet
```

`ZOLANA_PORT_OFFSET` shifts the page port with the localnet ports. Ctrl-C stops the dev server
and the localnet.

## Walkthrough

1. **Fund** Alice and Bob: an airdrop and a deposit into each shielded balance.
2. **Create a campaign** as the coordinator: a target and two windows, measured from the chain
   clock. The beneficiary is the page's beneficiary identity.
3. **Contribute** as Alice or Bob. The page proves the contribution, then the coordinator checks
   the preimage against that transaction, stores it and co-signs. Tick "Simulate a coordinator
   outage" to see a contribution refused at that step.
4. **Settle** as the coordinator once contributions close. Trying before the close shows the
   program's rejection (9112).
5. **Refund** as a contributor if the campaign failed. Each contribution is found again on every
   refresh from the indexer and the contributor's viewing key alone.

Each flow lists its stages (WASM, browser proof, local SPP prover, coordinator check, submit,
confirm, indexer sync) and names a program rejection with its error code.

## Key storage (prototype only)

- Every identity is a random Ed25519 seed in `localStorage`, labelled localnet-only. The page
  never asks for a wallet seed and does not use a browser wallet: nothing in the repository
  shows a wallet signing a v1 transaction.
- The coordinator's preimage store is also in `localStorage`. Clearing it while a campaign is
  open makes that campaign unsettleable; contributors still refund after the deadline.
- "New identities" discards all of it.

## Files

| File                                                                 | Purpose                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `index.html`, `src/style.css`, `src/main.ts`                         | The page and its rendering.                                                   |
| `src/app.ts`                                                         | The flows: fund, create, contribute, settle, refund, refresh.                 |
| `src/model.ts`                                                       | Stages, phases, amounts, errors, coordinator store encoding.                  |
| `src/identity.ts`                                                    | Disposable role seeds, campaign list and coordinator store in `localStorage`. |
| `src/fundraiser-wasm.ts`, `src/prover.ts`, `worker/prover-worker.js` | The WASM module and the threaded prover worker.                               |
| `vite.config.ts`                                                     | Cross-origin isolation, unbundled WASM, keys and worker, same-origin proxies. |
| `tests/unit/model.test.ts`, `tests/e2e/fundraiser.spec.ts`           | Unit tests and the Chromium flow.                                             |
