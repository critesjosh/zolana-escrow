# Timelock escrow web example

A small localnet web app around the existing [timelock escrow](../timelock_escrow.md). It walks
through the whole creator journey: fund a shielded balance, lock part of it until a chosen time,
find the open escrows again after a reload, see an early withdraw rejected, and reclaim the funds
after unlock.

It reuses the escrow's circuits, program, WASM bindings and TypeScript helpers
([`../typescript/core.ts`](../typescript/core.ts)). Nothing about the escrow itself changes for
the UI. Design notes: [`docs/timelock-escrow-web.md`](../../../docs/timelock-escrow-web.md).

> **Localnet only.** The app creates a disposable test identity and keeps its seed in
> `localStorage`. The escrow's proving keys come from a deterministic test setup and are unsafe
> for production. Never use this with real funds or a real wallet seed.

## Run it

From the repository root:

```sh
just escrow-web      # builds everything, starts a localnet, serves http://127.0.0.1:5180
```

Open <http://127.0.0.1:5180>. Ctrl-C stops the dev server and the localnet. Set
`ZOLANA_PORT_OFFSET` in `.env` to run beside another checkout (the app port shifts with it).

Checks and tests:

```sh
just check-escrow-web   # format, lint, typecheck, unit tests (no localnet)
just test-escrow-web    # the checks, then the browser flow in Chromium on a fresh localnet
```

## Prerequisites

Pinned versions, as checked on 2026-10-14:

| Tool             | Version                                                          | Notes                                     |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Rust             | 1.98.1                                                           | `rust-toolchain.toml`                     |
| Rust nightly     | nightly-2026-05-18, with `rust-src` and `wasm32-unknown-unknown` | threaded WASM build                       |
| Anza CLI         | 4.2.2 (platform-tools v1.54)                                     | provides `cargo build-sbf`                |
| surfpool         | 1.6.0 (`v1.6.0-light`)                                           | installed by `just ensure-surfpool`       |
| Go               | 1.27.1                                                           | fetched automatically by the Go toolchain |
| wasm-pack        | 0.15.0                                                           | `cargo install wasm-pack --locked`        |
| just             | 1.58.0                                                           | `cargo install just --locked`             |
| Node             | 24 or newer                                                      | `npm ci` from the repository root         |
| Vite, Playwright | 8.2.2, 1.63.0                                                    | this workspace's `package.json`           |
| Chromium         | Playwright build 1243                                            | `npx playwright install chromium`         |

Install the Anza CLI without touching your shell profile:

```sh
curl -sSfL https://release.anza.xyz/v4.2.2/install -o /tmp/anza-install
sh /tmp/anza-install --no-modify-path v4.2.2
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

## How it works

### Two proofs, one transaction

Each lock and each withdraw carries two Groth16 proofs about the same private transaction:

1. **The escrow proof** (escrow or withdraw circuit) proves the escrow's own rules. A lock moves
   exactly `amount` into an escrow UTXO owned by the creator's escrow-authority PDA, with the
   creator and `unlock` committed in its data. A withdraw spends that UTXO back to the same
   creator, and its public input reveals `unlock`. The browser proves it in a worker from the
   threaded WASM build.
2. **The SPP proof** proves the shielded pool's rules for the same transaction: input membership,
   nullifiers, and value conservation. The local Go prover builds it through
   `client.proveTransact`.

Both proofs commit to the same `private_tx_hash`. The escrow program verifies its proof, checks
`now > unlock` on withdraw, then calls the shielded pool's `transact`, which verifies the SPP
proof. Neither proof is valid for a different transaction.

### Progress stages

The page shows only stages the code can observe. A lock or withdraw runs: preparing (WASM proof
inputs), proving the escrow rules (worker), proving the SPP transfer (prover), submitting,
confirming (returns the slot), and syncing (an indexer read gated on that slot, so the page never
shows state from before the transaction). There is no "awaiting signature" stage, because the
disposable identity signs locally.

### Discovery and reload

Only the seed is stored. On every load and after every confirmed transaction, the page queries
Photon for two tags: the creator's view tag (its own UTXOs) and the escrow-authority owner tag
(its escrows). It then decrypts both with the creator's viewing key and drops escrows whose
nullifier is published. A reload therefore finds the same balance and escrows. The query reads
one page of 50 transactions, and the page warns when that page is full.

### Identity and signing

The page derives the Solana signer and the shielded keys from one Ed25519 seed, the same way as
the Node test. A browser wallet is not used: every transaction here is version 1 (SIMD-0385),
and nothing in this repository shows a browser wallet signing one. The SDK can derive shielded
keys from a wallet signature (`LocalKeys.fromDerivationSeed`), so wallet support is a follow-up
once version 1 signing is confirmed.

Registration is not needed. Deposits, escrows and withdrawals all pay the creator's own address,
so no one else has to look it up.

### Browser setup

- The threaded prover needs `SharedArrayBuffer`, so every response carries
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- The WASM package, the proving keys and the worker are served unbundled
  ([`vite.config.ts`](vite.config.ts)). `wasm-bindgen-rayon` starts its thread workers from a
  helper that imports the package by relative URL, which bundling would break.
- The RPC, its WebSocket, Photon and the prover are proxied on the page's origin. The prover
  sends no CORS headers.
- Browser-safe helpers live in `../typescript/core.ts`. Node-only parts (file reads, env config,
  the Node WASM build) stay in `../typescript/escrow.ts`.

## Privacy

Checked against the program source:

- **Confidential:** the locked amount and the shielded balance.
- **Public:** the creator's Solana address (it signs both instructions), which instruction ran,
  the escrow-authority PDA (derivable from the creator), and the asset (SOL).
- **Revealed at withdraw:** the unlock time, sent in plain instruction data and checked against
  the Clock.
- **Unlinkable:** with several open escrows, an observer cannot tell which one a withdraw spends.
- **Seen by the prover:** the SPP prover receives the full private transaction, including the
  nullifier key. On localnet that is your own process. A hosted prover would see it.

## What the browser test exercises

[`tests/e2e/escrow.spec.ts`](tests/e2e/escrow.spec.ts) runs against a real localnet: deposit
0.5 SOL, lock 0.3 SOL for 20 seconds, try to withdraw early (rejected with program error 9005),
reload and rediscover the escrow, wait for the on-chain clock to pass the unlock, withdraw, check
that the balance is back to 0.5 SOL, and reload again. It takes about 25 seconds, most of it the
lock. The unit tests cover stage tracking, escrow status at the unlock boundary, amount parsing,
error mapping, identity storage and input selection.

## Troubleshooting

These all came up while building the example.

- **`cargo-build-sbf not found`:** the Anza CLI is missing or not on `PATH`. See
  [Prerequisites](#prerequisites).
- **`failed to find required binary (SURFPOOL_BIN, surfpool)`:** run `just ensure-surfpool`.
  The escrow recipes now depend on it.
- **`surfpool start` fails with `not a terminal`:** run from the repository root, surfpool tries
  to pick programs to deploy interactively. Use `just escrow-localnet`, which goes through
  `zolana dev start`.
- **Proving never finishes, and the worker request fails with `ERR_BLOCKED_BY_RESPONSE`:** the
  worker script was served without COEP, so the isolated page refused it. Vite's `public/`
  handler does not apply `server.headers`, which is why the worker is served from `worker/`.
- **"This page is not cross-origin isolated":** open it through the dev server at
  `http://127.0.0.1:5180`, not from another server or a file URL.
- **"not yet unlocked (error 9005)":** expected before the on-chain clock passes the unlock
  time. The localnet clock follows the host clock, about a second behind.
- **Vite warns `Module "buffer" has been externalized`:** harmless. `@lightprotocol/hasher.rs`
  uses `Buffer` only on a Node-only code path.
- **`using deprecated parameters for the initialization function`:** harmless, from
  `wasm-bindgen-rayon`'s thread workers.
- **Port already in use:** another localnet is running. Run `just escrow-localnet-stop`, or set
  `ZOLANA_PORT_OFFSET` in `.env`.

## SDK and docs improvements found

- **Program-owned UTXO discovery** lives in example code (`escrowUtxos`): tag query, decrypt,
  nullifier filter. An SDK helper for UTXOs owned by a program PDA would remove most of it.
- **No paging** in that discovery: `getShieldedTransactionsByTags` is read once with
  `limit: 50`.
- **Input selection** for ZK program inputs is hand-written here (largest first, at most five).
  The SDK's own `selectUtxos` (`sdk-libs/ts/src/flows/select.ts`) is `@internal` and not
  exported, so program examples cannot reuse it.
- **The prover sends no CORS headers,** so every browser app needs a same-origin proxy.
- **No way to read the Clock** from the SDK. The example decodes the sysvar itself, and
  `@solana/kit` does not re-export `@solana/sysvars`.
- **The escrow tests used an unlock in 1970,** so nothing checked that the time lock blocks an
  early withdraw. The TypeScript test now does. The Rust validator test (`program/tests/escrow.rs`)
  still uses a past unlock.
- **`test-escrow-ts` did not depend on `ensure-surfpool`,** so it failed on a fresh machine.
  Fixed through the shared `escrow-localnet` recipe.
