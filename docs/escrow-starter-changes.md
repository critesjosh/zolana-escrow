# Changes on `crites/escrow-starter`

Base: `jorrit/feat-zk-dsl` at `7442e9cb5` (helius-labs/zolana). Everything below is new on
this branch. No program, circuit, SDK (`sdk-libs/`) or spec file changed.

## Summary

1. **Agent instructions** follow the agentic-dev-template conventions: `AGENTS.md` is the
   source, `CLAUDE.md` links to it, and there is a decision-record template.
2. **The escrow TypeScript test** now proves the time lock works: an early withdraw is rejected
   before a successful one. It used to lock until 1970.
3. **The escrow TypeScript helpers** are split so a browser can use them.
4. **A localnet web example** for the timelock escrow, with unit tests and a Playwright test
   against a real localnet.
5. **Shared justfile recipes** for the escrow localnet, and new recipes for the web example.

## 1. Agent instructions and repository hygiene

| File | Change |
| --- | --- |
| `AGENTS.md` | The former root `CLAUDE.md`, unchanged except for a new "Working Rules" section: read the README, spec and nearest `CLAUDE.md` first; lead with the outcome; verify with the narrowest `just` recipe and report results; update docs before calling work done; share a plan before changing architecture, public SDK interfaces, layouts or major dependencies; record decisions; keep credentials out of tracked files; ask when uncertain. |
| `CLAUDE.md` | Now a symlink to `AGENTS.md`, so both names show the same instructions. Git shows it as a 664-line deletion plus a type change. |
| `docs/decisions/TEMPLATE.md` | New decision-record template (context, decision, alternatives and tradeoffs). |
| `.gitignore` | Removed an unanchored `docs` rule that ignored every new file under `docs/` (it arrived with an unrelated commit, `6a1e019c5`). The narrower `docs/...` rules below it still apply. Added `/.env.*` with `!/.env.example`, so local env variants stay untracked. |

Template items left out on purpose: `docs/DESIGN.md` (the repo already uses `docs/spec.md`),
`PROGRESS.md`, and the template's new-project checklist.

## 2. Escrow TypeScript test

`sdk-tests/timelock-escrow/typescript/escrow.test.ts`:

- The unlock is now 20 seconds past the on-chain clock instead of the fixed `1_000_000` (1970).
- After proving the withdraw, the test sends it before unlock and expects program error 9005
  (`NotYetUnlocked`), waits for the on-chain clock to pass the unlock, then sends the same
  withdraw again and expects success.
- `airdrop` takes the client rather than a config.

The Rust validator test (`program/tests/escrow.rs`) still uses a past unlock and was not changed.

## 3. Escrow helper split

| File | Change |
| --- | --- |
| `typescript/core.ts` | New. The browser-safe helpers moved out of `escrow.ts`: instructions, PDA, tag query, balance, escrow discovery, `sendAndConfirmFactory`. New: `chainUnixTimestamp` (reads the Clock sysvar), `customErrorCode` (finds a program error code in an error's cause chain), `keypairFromSeed`, `hex`, `compareBigint`, `NOT_YET_UNLOCKED`. `escrowUtxos` takes the WASM terms decoder as a parameter instead of importing the Node build. `sendAndConfirmFactory` can report `submitting` and `confirming` stages. `airdrop` uses the client's own RPC and subscriptions. |
| `typescript/escrow.ts` | Now only the Node-only parts: env config, proving-key file reads, the Node WASM build. Re-exports `core.ts`, so the test's imports barely changed. |
| `typescript/wasm-types.ts` | New. Shared types of the escrow WASM module. |

Paths are under `sdk-tests/timelock-escrow/`.

## 4. Web example (`sdk-tests/timelock-escrow/web/`)

A vanilla TypeScript and Vite app, added as an npm workspace. See its
[README](../sdk-tests/timelock-escrow/web/README.md) and the
[design](timelock-escrow-web.md).

| File | Purpose |
| --- | --- |
| `index.html`, `src/style.css`, `src/main.ts` | The page: identity, fund, lock, escrow list, progress stages, privacy notes. |
| `src/app.ts` | The flows (fund, lock, withdraw, refresh), in the same order as the Node test and built on `core.ts` and the SDK. |
| `src/model.ts` | Stage tracking, escrow status, SOL amounts, error messages. |
| `src/identity.ts` | The disposable localnet seed in `localStorage`. |
| `src/escrow-wasm.ts`, `src/prover.ts`, `worker/prover-worker.js` | The WASM module on the main thread, and the threaded prover in a worker. |
| `vite.config.ts` | Cross-origin isolation headers, unbundled WASM, keys and worker, and same-origin proxies for the RPC, its WebSocket, Photon and the prover. |
| `tests/unit/model.test.ts` | 14 unit tests. |
| `tests/e2e/escrow.spec.ts`, `playwright.config.ts` | The browser flow against localnet. |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `README.md` | Workspace setup and docs. |

Design choices, all recorded in the design doc:

- **Identity:** a labelled disposable localnet identity, not a browser wallet. Every
  transaction is version 1, and nothing in the repo shows a wallet signing one.
- **Proofs:** the escrow and withdraw proofs run in the browser. The SPP proof runs on the
  local prover, which sees the full private transaction.
- **Discovery:** reload recovery reruns the indexer tag query, and only the seed is stored.
- **Registration:** not needed, since all funds go to the creator's own address.

## 5. Build and dependency changes

| File | Change |
| --- | --- |
| `justfile` | New `escrow-localnet` (starts the shielded pool, the escrow, Photon and the prover) and `escrow-localnet-stop`, factored out of `test-escrow-ts`. `escrow-localnet` now depends on `ensure-surfpool`, which `test-escrow-ts` was missing on a fresh machine. New `escrow-web`, `check-escrow-web` and `test-escrow-web`. |
| `package.json` | Adds the `sdk-tests/timelock-escrow/web` workspace. |
| `package-lock.json` | Adds `@playwright/test` 1.63.0 and the workspace link. Vite 8.2.2 was already installed through vitest. npm also corrected the stale `sdk-libs/ts` entry (0.2.0-alpha to the package's actual 0.3.2-alpha) and dropped `peer` flags. No other versions changed. |

## 6. Docs

| File | Purpose |
| --- | --- |
| `docs/timelock-escrow-web.md` | Design, baseline (toolchain, commands, failures) and validation results. |
| `docs/escrow-starter-changes.md` | This file. |

## Verification

Run on 2026-10-14 with Rust 1.98.1, Anza CLI 4.2.2, surfpool 1.6.0 and Node 24.12.0:

- `just test-escrow-ts`: passed, including the early withdraw rejected with 9005.
- `just test-escrow-web`: format, lint and typecheck passed; 14 unit tests passed; the
  Chromium flow passed against a fresh localnet in about 28 seconds.
- `just escrow-web`: serves the isolated page, and Ctrl-C stops the localnet.
- All localnet and dev-server ports were free after each run.

Not run: the full Rust suites (`just test-hermetic`, the validator tests) and CI.
