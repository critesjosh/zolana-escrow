# Timelock escrow web example: design

Status: Implemented 2026-10-14 in `sdk-tests/timelock-escrow/web/` (see its
[README](../sdk-tests/timelock-escrow/web/README.md)). Vite, Playwright, and the
`escrow.ts` split were approved.

## Goal

A small localnet web app that walks a developer through the existing timelock
escrow: fund a shielded balance, lock part of it until a chosen time, find the
open escrows again after a reload, and reclaim them after unlock. It should be
reproducible from a clean checkout and grow into an SDK example and tutorial.

## Non-goals

- No new escrow protocol, circuit, or program change to suit the UI.
- No counterparty, arbitration, or payment escrow. The creator locks and the
  same creator reclaims.
- No public deployment, package publish, chatbot, MCP server, or agent framework.
- No real wallet seeds. The app never asks for or imports one.
- No tutorial-length write-up in v1 (see [Docs](#docs)).

## Baseline

Recorded 2026-10-14 on Linux x86_64, starting commit `7442e9cb5` on
`crites/escrow-starter`.

| Tool | Version | Source of the pin |
| --- | --- | --- |
| Rust | 1.98.1 | `rust-toolchain.toml` |
| Rust nightly | nightly-2026-05-18 with `rust-src`, `wasm32-unknown-unknown` | `cli/src/args.rs`, escrow WASM build |
| Anza CLI (`cargo build-sbf`) | 4.2.2, platform-tools v1.54 | CI `AGAVE_VERSION`, justfile `sbf-tools-version` |
| surfpool | 1.6.0 (`v1.6.0-light`) | justfile |
| Go | 1.22.2 installed, 1.27.1 fetched by Go's automatic toolchain download | `prover/server/go.mod` |
| Node / npm | 24.12.0 / 11.6.2 | local |
| just, cargo-nextest, wasm-pack | 1.58.0, 0.9.148, 0.15.0 | latest at setup |

Commands that passed:

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
just ensure-surfpool
just test-escrow-ts   # 1 test passed; ~4.5 min cold, 21 s warm
```

Failures seen on the way:

- `cargo-build-sbf not found`: the Anza CLI was not installed. Installed v4.2.2
  with `sh install --no-modify-path v4.2.2` (the release tag is required once
  any flag is passed).
- `failed to find required binary (SURFPOOL_BIN, surfpool)`: `test-escrow-ts`
  does not depend on `ensure-surfpool`. Run `just ensure-surfpool` first.
- `surfpool start` run by hand from the repo root fails with `not a terminal`
  while picking programs to deploy. Use `zolana dev start`, as the recipe does.

The recipe kills its RPC, Photon and prover ports on start and on exit, and
deletes `target/escrow-ts` on start. All ports were free after the run.

## What the existing code provides

| Need | Existing piece | Browser-ready? |
| --- | --- | --- |
| Client, deposit, SPP proof, confirm | `@heliuslabs/zolana` (`sdk-libs/ts`) | Yes. No `node:` imports in `src`. |
| Escrow and withdraw proof inputs and provers | Escrow WASM (`just build-escrow-wasm`, web target) | Yes, multi-threaded: needs cross-origin isolation and a worker. |
| Escrow instructions, PDA, discovery, balance | `sdk-tests/timelock-escrow/typescript/escrow.ts` | No. Imports `node:fs`, the Node WASM build, `Buffer` and `process.env`. |
| Browser WASM harness, isolation headers | `sdk-libs/program/tests/wasm` (Playwright, `serve.mjs`) | Pattern to follow. |
| Localnet with both programs, Photon, prover | `test-escrow-ts` recipe (`zolana dev start ... --sbf-program`) | Reused as is. |
| Moving the localnet clock | `surfnet_timeTravel` RPC (used by `ring-controls.live.test.ts`) | Usable from tests. |

## Proposed design

### Location and stack

- App in `sdk-tests/timelock-escrow/web/`, beside the existing `program/` and
  `typescript/` directories.
- Vanilla TypeScript with Vite. The repo has no frontend framework. Vite covers
  bundling the SDK, the worker, the WASM module, the isolation headers, and a
  same-origin proxy.
- Playwright drives the browser test, as in `sdk-libs/program/tests/wasm`.
- `just escrow-web` starts the same localnet as `test-escrow-ts` (through the
  shared `escrow-localnet` recipe), builds the web WASM, and runs the dev
  server. `just check-escrow-web` and `just test-escrow-web` run the checks and
  the browser test.

### Shared escrow helpers

Split `typescript/escrow.ts` into a browser-safe `core.ts` (instructions, PDA,
discovery, balance, Clock, error codes) and the Node-only parts left in
`escrow.ts` (WASM loading, proving-key file reads, env config). The Node test keeps working against the same helpers, so
the app does not duplicate discovery or instruction building.

### Identity and signing

Decision: an explicitly labelled disposable localnet identity.

- The app generates a random Ed25519 seed, keeps it in `localStorage` under a
  "localnet only" label, and derives the Solana signer and the shielded keys
  from it, exactly as the escrow test does. A reset button discards it.
- Funding is a localnet airdrop.
- Alternative considered: a browser wallet. The SDK supports deriving shielded
  keys from a wallet signature (`LocalKeys.fromDerivationSeed`, Phantom-tested
  per the source comments). But every transaction here is version 1
  (SIMD-0385), and nothing in the repo shows a browser wallet signing one. The
  creator also signs twice per withdraw (fee payer and creator). Deferred until
  wallet v1 support is confirmed.
- Registration is not required. The baseline lifecycle passes without it,
  because deposits, escrows and withdrawals all pay the creator's own address.
  The app explains why the step is absent.

### Proving

- Escrow and withdraw proofs run in the browser, in a worker, from the web
  WASM build. The WASM package, the proving keys (from
  `target/zk/timelock-escrow-program/`) and the worker are served unbundled,
  because `wasm-bindgen-rayon` imports the package by relative URL.
- The SPP transfer proof runs on the local Go prover through
  `client.proveTransact`.
- The prover sends no CORS headers, and the page is cross-origin isolated
  (COOP `same-origin`, COEP `require-corp`). The dev server proxies the
  prover, Photon and the RPC on the same origin.

### Discovery and reload recovery

On load, and after each confirmed transaction:

1. Query Photon with `getShieldedTransactionsByTags` for the creator's view tag
   and the escrow-authority owner tag, gated with `atSlot(confirmedSlot)`.
2. Decrypt the creator's UTXOs for the balance and the escrow UTXOs for the
   list, skipping spent nullifiers (the existing `spendableSol` and
   `escrowUtxos` logic).

Nothing but the seed is stored, so a reload reruns the same discovery. Known
limit: the helper reads one page of 50 transactions. The app will show a
warning if that page is full rather than silently miss escrows.

### Progress stages

Only stages the code can observe:

| Stage | Source |
| --- | --- |
| Preparing | `escrowTransaction` or `withdrawTransaction` (WASM) |
| Proving escrow rules | Worker proof (WASM) |
| Proving SPP transfer | `client.proveTransact` (prover) |
| Submitting | `sendTransaction` |
| Confirming | `client.confirmTransaction`, which returns the slot |
| Syncing | Indexer read gated on that slot |

There is no "awaiting signature" stage, because the disposable signer signs
locally.

### Unlock time

The user picks an unlock time. The program allows withdrawal only when the
on-chain Clock is past it (`now > unlock`). An early attempt returns custom
error `9005` (`NotYetUnlocked`), which the app shows plainly. The localnet
Clock follows the host clock, about one second behind (checked 2026-10-14), so
an unlock a minute ahead works without moving the clock. The app measures the
unlock from the on-chain clock, not the browser's. The browser test uses a real
20-second window; `surfnet_timeTravel` was not needed.

## Privacy boundaries

Checked against `timelock_escrow.md` and the program source:

- **Confidential:** the amount, and the per-asset volume.
- **Public:** the creator's Solana address (it signs both instructions), which
  instruction ran, the escrow-authority PDA (an account in both, derivable
  from the creator), and the asset ID (an SPP public input).
- **Revealed at withdraw:** the unlock time, sent in plain instruction data and
  checked against the Clock.
- **Unlinkable:** with several open escrows, an observer cannot tell which one
  a withdraw spends.
- **Not covered in the brief:** the SPP prover receives the full private
  transaction, including the nullifier key, to build the SPP proof. On
  localnet that is your own process. A hosted prover would see it, which is
  in tension with the principle that secrets stay in the wallet
  (`docs/CLAUDE.md`).

## Validation

Results on 2026-10-14:

- **Browser flow** (`just test-escrow-web`): passed in Chromium against a fresh
  localnet in about 25 seconds. It deposits, locks for 20 seconds, sees an early
  withdraw rejected with error 9005, reloads and rediscovers the escrow, waits
  for the on-chain clock, withdraws, checks the balance, and reloads again.
- **Unit tests**: 14 passed (stage tracking, the unlock boundary, amounts,
  error mapping, identity storage, input selection).
- **`just test-escrow-ts`**: passes after the split, now including an early
  withdraw rejected with error 9005. Before this change the test locked until
  1970, so the time lock was never exercised.
- All localnet and dev-server ports were free after each run.

## Docs

v1 ships with a README in the app directory: setup and run commands with pinned
versions, how the escrow proof and the SPP proof fit together, troubleshooting
from failures actually seen, and a list of SDK and docs improvements found
along the way.

## Open questions

None open. Resolved:

1. Vite and Playwright: approved.
2. Splitting `typescript/escrow.ts`: approved.
3. The surfpool clock follows the host clock.
4. Registration is not required for this flow.

## SDK improvements

The full list, with what was fixed here, is in the
[app README](../sdk-tests/timelock-escrow/web/README.md#sdk-and-docs-improvements-found).
