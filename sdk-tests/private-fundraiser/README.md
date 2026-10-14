# Private fundraiser

An all-or-nothing fundraiser on SPP with confidential contribution amounts. A localnet prototype
and developer example built from the [timelock escrow](../timelock-escrow/timelock_escrow.md),
not production software. Its verifying keys come from the SDK's insecure deterministic test
setup.

- Contributors commit SOL from their shielded balance into a contribution UTXO owned by a
  campaign PDA.
- After contributions close, a proof shows that the registered contributions reach a public
  target, and pays them all to a fixed shielded beneficiary.
- If that does not happen before the settlement deadline, each contributor refunds its own
  contribution, with no help from the coordinator.

The design, its tradeoffs and the prior Solidity version it replaces are in
[docs/private-fundraiser-design.md](../../docs/private-fundraiser-design.md). The decisions are
recorded in [docs/decisions/2026-10-14-private-fundraiser.md](../../docs/decisions/2026-10-14-private-fundraiser.md).

## Layout

| Path                                         | Contents                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `program/src/lib.rs`, `state.rs`, `error.rs` | Pinocchio program: `create`, `contribute`, `settle`, `refund`; the `Campaign` account; errors 9100 to 9118. |
| `program/src/instructions/`                  | Handlers: time windows, account checks, the registry and the campaign-authority CPI into SPP.               |
| `program/src/circuits/`                      | DSL circuits: `Contribute`, `Settle1` to `Settle4`, `Refund`, and `ContributionTerms`.                      |
| `program/src/client.rs`                      | Rust instruction builders and `CampaignView`.                                                               |
| `program/tests/zk_functional.rs`             | Circuits natively and in R1CS, proofs checked by the program's generated verifiers.                         |
| `program/tests/fundraiser.rs`                | Proof-carrying localnet lifecycle (tests 20, 21 and 22 of `LocalnetPorts::for_test`).                       |
| `typescript/`                                | Browser-safe helpers (`core.ts`), Node helpers and the TypeScript localnet test.                            |
| `web/`                                       | Localnet web example; see its [README](web/README.md).                                                      |

## Instructions

| Instruction  | Allowed when                                    | Signers                  | Effect                                                                                 |
| ------------ | ----------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `create`     | `now < close < settle_deadline`, `target > 0`   | coordinator              | Creates the campaign account with immutable terms.                                     |
| `contribute` | `now < close`, open, fewer than 4 contributions | contributor, coordinator | Verifies the contribute proof, registers the contribution UTXO hash, CPIs SPP.         |
| `settle`     | `close <= now < settle_deadline`, open          | any payer                | Verifies `settle<n>` against the whole registry, marks the campaign settled, CPIs SPP. |
| `refund`     | `now >= settle_deadline`, not settled           | contributor              | Verifies the refund proof for one registry entry, marks it refunded, CPIs SPP.         |

Settle and refund windows do not overlap, so a payout and a refund cannot both succeed.

## Privacy and trust

- **Private from observers:** each amount and the total. Settlement shows only that the total
  reached the target.
- **Public:** campaign terms, each contributor's Solana address, the number of contributions,
  which instruction ran and the outcome.
- **The coordinator** sees every contribution: it co-signs only after checking the contribution
  preimage against the exact transaction, and it needs every preimage to settle. It cannot send
  funds anywhere except the beneficiary or back to contributors.
- **Coordinator liveness:** nobody can contribute unless the coordinator is online and agrees to
  co-sign, so it can censor or stall a campaign. If it never settles, a funded campaign fails at
  the settlement deadline and everyone refunds. Refunds never need it.
- **The beneficiary** learns the total from its payout.
- **The prover:** SPP proofs come from the local prover server, which receives the full private
  transaction. Program proofs run in-process (Node) or in a browser worker.

## Run and test

Every recipe needs the Anza CLI (4.2.x) on `PATH`, as for the other examples. If `cargo
build-sbf` is not found in a script, prepend
`~/.local/share/solana/install/active_release/bin`.

```bash
just test-fundraiser-circuits    # circuits, no validator (about 10 s)
just test-fundraiser-validator   # Rust lifecycle on three localnets (about 2 min)
just test-fundraiser-ts          # TypeScript lifecycle with WASM proofs (about 2 min)
just check-fundraiser-web        # web format, lint, typecheck, unit tests
just test-fundraiser-web         # web flow in Chromium on a localnet (about 3 min)
just fundraiser-web              # serve the web example on a fresh localnet
```

The localnet recipes free their ports on exit through `just escrow-localnet-stop`.

## Status

**Implemented and verified on localnet with proof-carrying transactions**
(`test-fundraiser-validator`, `test-fundraiser-ts`, `test-fundraiser-web`):

- A three-contributor campaign settles and the beneficiary receives the sum (`settle3`), as do
  a two-contributor campaign in the TypeScript and web tests (`settle2`) and a full
  four-contributor campaign (`settle4`, 4 inputs and 3 outputs, within the v1 size and compute
  limits).
- An under-target campaign cannot be settled (no settle proof exists), and four contributors
  each refund independently after a coordinator outage, rediscovering their contribution from
  the chain with only their keys.
- Rejections with their program errors: a non-coordinator co-signer (9108), a corrupted proof
  (9100), a contribution after the close (9109) or past the cap (9110), settlement before the
  close (9112) or after the deadline (9113), a second settlement and a refund after success
  (9114), a refund before the deadline (9116), a refund signed by someone else or aimed at
  another registry entry (9100), and a second refund (9118).
- A replayed contribution reaches the registry write and then fails in SPP; the campaign count
  is unchanged.

**Verified natively and in R1CS only** (`test-fundraiser-circuits`): settle refuses a shortfall,
a substituted or reordered contribution, another beneficiary, campaign or campaign authority;
contribute refuses an empty amount and another owner's tokens; refund refuses another
contributor, campaign or registry entry. Every proof leaves no private variable unconstrained.

**Assumed, not verified:**

- Unsolicited UTXOs sent to the campaign authority are never counted (they have a zero data
  hash and are never registered) and are stranded. No test sends one.
- The payout is encrypted to the beneficiary's viewing key, which no proof enforces.
- `settle1` is proven natively and its SPP proof was produced on localnet, but no test sends it.

## SDK and docs gaps found

1. **Padding outputs in ZK program transactions do not prove.** The program client pads unused
   output slots with empty outputs that have no `owner_tag`, so the SPP witness publishes
   `solana_owner_identity([0; 32])` as their tag, which the default-ring circuit rejects
   (`AssertDummyTags`). Any program transaction whose outputs do not fill its SPP shape fails
   at the prover. The fundraiser avoids it: settle adds zero-amount outputs to the beneficiary,
   and contribute spends at most two token inputs.
2. **No variable-count data UTXO spends.** `DataUtxo::spend` refuses a dummy, so a program that
   spends up to `n` data UTXOs needs one circuit per count.
3. **A circuit cannot publish its own output hash.** Output hashes are computed in
   `ConfidentialTransaction::check`, after the public inputs, so the program reads the
   contribution's hash from the transact at its slot.
4. **Only one decryptor per output.** A program output is encrypted to the viewing key the
   client chooses, so sharing a preimage with a second party (the coordinator) needs an
   off-chain channel; the DSL has no verifiable encryption.
5. **Discovery under a PDA tag misses spends tagged elsewhere.** `decrypt_data_utxos` only drops
   UTXOs spent by the transactions it was given, so a contribution spent by a settlement
   (tagged with the beneficiary) still looks open. The helpers filter by the campaign's public
   state instead.
6. **`include_zk_programs!` only scans literal structs** and only accepts integer, bool and hash
   public fields, so per-count circuits are written out by hand.
7. **Docs:** `timelock_escrow.md` does not mention that its shapes need no padding outputs, and
   the SDK README does not state the padding limitation above.
