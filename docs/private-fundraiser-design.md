# Private fundraiser design

Status: implemented, 2026-10-14. Code, commands and verification status are in
[sdk-tests/private-fundraiser/README.md](../sdk-tests/private-fundraiser/README.md); the
decisions are in [decisions/2026-10-14-private-fundraiser.md](decisions/2026-10-14-private-fundraiser.md).

An all-or-nothing fundraiser on SPP, built from the timelock escrow example. Contribution
amounts and the total are confidential. A localnet prototype and developer example, not
production software.

## 1. Baseline

| Item | Value |
| --- | --- |
| Branch | `crites/private-fundraiser`, from `crites/escrow-starter` at `43059996b` |
| Relationship to `jorrit/feat-zk-dsl` | Ancestor. `crites/escrow-starter` is 4 commits ahead (agent docs, escrow test fix, helper split, web example; no SDK, program or spec changes, see [escrow-starter-changes.md](escrow-starter-changes.md)). Local `jorrit/feat-zk-dsl` equals upstream `7442e9cb5`. |
| Tools | Rust 1.98.1, Anza CLI 4.2.2, surfpool (repo-pinned, `target/tools/surfpool`), Node 24.12.0, just 1.58.0 |
| `just test-escrow-ts` | Passed: the lifecycle test proves escrow and withdraw against a real localnet and rejects an early withdraw with 9005. Ports 8899, 8900, 8784 and 3001 were free before and after. |

Blocker found: the first run failed with `no such command: build-sbf`. The Anza CLI is
installed under `~/.local/share/solana/install/active_release/bin` but is not on the PATH of a
non-interactive shell. Prepending it fixed the run. Every later recipe needs the same PATH.

Port cleanup was checked before running: `escrow-localnet-stop` kills only listeners on this
checkout's RPC, WebSocket, Photon and prover ports.

## 2. Feasibility summary

The proposed design is feasible with the existing DSL, SDK and SPP CPI. Six changes to the
hypothesis are needed, each explained below (the sixth was found during implementation):

1. **Settlement is one circuit per contribution count**, not one padded circuit. The DSL refuses
   a dummy as a data UTXO input (`DataUtxo::spend` asserts the UTXO domain), and
   `include_zk_programs!` only accepts integer, bool and hash public fields. So `settle_1` to
   `settle_4` share one generic circuit function, and the program picks the verifier by the
   registry count.
2. **The program registers the contribution by reading the transact's output hash at a fixed
   slot**, not from a proof public input. Output hashes are computed inside
   `ConfidentialTransaction::check`, after the public inputs are fixed, so a circuit cannot
   expose its own output hash without an SDK change. The spec's slot rule (real outputs keep
   their slot and derived blinding) makes the slot read sound. This needs a negative test.
3. **The coordinator co-signs each contribution.** An output is encrypted to one viewing key,
   which the client chooses. Encrypting to the contributor keeps refunds independent, but then
   the coordinator only learns the preimage off-chain. Without co-signing, one contributor who
   withholds or garbles their preimage blocks settlement for everyone. Verifiable encryption
   would fix this in-circuit, but only the gnark swap example has it, and adding it to the DSL
   is a new primitive (out of scope).
4. **Refunds also expose the spent contribution hash** as a public input, so the program checks
   it against the registry and marks it refunded. SPP nullifiers already stop double spends;
   this adds defense in depth and a public refund status.
5. **`UniqueDataUtxo` is not used.** The client cannot create addresses yet
   (`UnsupportedAddressCreation`). A conventional campaign account holds the registry.
6. **No padding outputs.** The SDK pads a program transaction's unused output slots with empty
   outputs whose SPP witness carries a zero owner tag, which the default-ring circuit rejects
   (found when `settle2` failed at the prover). Settle fills its shape with zero-amount outputs
   to the beneficiary (shapes 1x1, 2x2, 3x3, 4x3), and contribute spends at most two token
   inputs (1x2 or 2x2).

## 3. Prior application: what carries over

Reference: [past-my-shades `c2b4198`](https://github.com/critesjosh/past-my-shades/tree/c2b4198e45bf3e4a6a4538bebec9491814280536)
(Noir circuits, Bank of Jubjub encrypted balances). Read as design context. Behavior below is
from reading the code, not from running it.

| Aspect | past-my-shades | This design |
| --- | --- | --- |
| Commitment of funds | The contributor locks their whole encrypted-balance account to the fundraiser and stores a pre-proven transfer, executed later. Only one pending contribution per account. Execution can fail if the stored proof's old balance no longer matches. | Funds move at contribution into a per-contribution UTXO owned by a campaign PDA. Only the contributed amount moves; the rest of the wallet is untouched. Settlement cannot fail for balance reasons. |
| Aggregation | Homomorphic ElGamal running total, encrypted to the recipient (`correct_zero`, `correct_addition`). | No running total. The coordinator sums the contribution preimages inside the settle circuit. No new primitive. |
| Threshold and payout | Two steps: `setThresholdMet` (recipient decrypts the total and proves `>= threshold`), then `processContributions` in batches. | One atomic transaction: the settle proof checks the sum against the target and pays the beneficiary. |
| Settlement timing | No settlement deadline. `contribute` never checks `endTime`. | Contributions close at a deadline; settlement is allowed only between close and a settlement deadline. |
| Cancellation and refunds | `revokeContribution` checks `endTime >= block.timestamp`, so it only works before the end, the opposite of its comment. After the end, an unprocessed contribution keeps the account locked indefinitely. The revoke proof only proves key knowledge over a public key and is replayable. | No early cancellation (out of scope). Refunds start at the settlement deadline if the campaign did not settle, need the contributor's Solana signature and need no coordinator. |
| Coordinator visibility | The recipient decrypts every contribution and the total. | The coordinator sees every contribution. The beneficiary learns the total from its payout. Neither needs to be the same party. |
| Fees, multisig recipients | Relay fees, paid on success; EVM controller accounts. | Dropped. The beneficiary is a shielded address. |
| Other observed bugs not carried over | `processContributions` loops to a constant 10, ignoring `contributionCount` and revoked slots. | The settle circuit consumes exactly the registered set. |

Preserved semantics: all-or-nothing against a public target, confidential amounts, a fixed
recipient set at creation, public participation, and a trusted party that learns amounts but
cannot redirect funds.

## 4. Design

### Parties

- **Coordinator:** creates the campaign, co-signs contributions, stores their preimages and
  submits settlement. Trusted for liveness and for amount privacy, not for funds.
- **Contributor:** a disposable localnet Solana keypair with shielded keys.
- **Beneficiary:** a shielded address fixed at creation.

### Accounts and PDAs

New program `sdk-tests/private-fundraiser/` (a copy of the escrow layout, escrow left unchanged).

```text
campaign            = PDA [b"campaign", coordinator, campaign_seed: u64]
campaign_authority  = PDA [b"campaign_authority", campaign]   // owns every contribution UTXO
campaign_id         = hash_bytes(campaign)                      // the field value circuits bind
```

```rust
#[repr(C)]
pub struct Campaign {
    discriminator: u8,
    status: u8,                    // Open = 0, Settled = 1
    count: u8,                     // registered contributions, <= MAX_CONTRIBUTIONS
    refunded: u8,                  // bitmap over registry slots
    bump: u8,
    coordinator: [u8; 32],
    beneficiary_owner_hash: [u8; 32],
    beneficiary_viewing_pk: [u8; 33],  // for clients only; not enforced by any proof
    asset_id: u64,                 // SOL only in this prototype
    target: u64,
    close_ts: i64,
    settle_deadline: i64,
    registry: [[u8; 32]; MAX_CONTRIBUTIONS],
}
```

`MAX_CONTRIBUTIONS = 4`. SPP supports 4 inputs (`IN4_OUT3`), so the cap is set by proof
count and transaction size, which Phase 2 measures. Terms are written once at creation and no
instruction changes them.

### Contribution terms (data UTXO state)

```rust
#[derive(CircuitType)]
pub struct ContributionTerms {
    pub campaign_id: [u8; 32],
    pub contributor: Owner,            // refund owner, from the spent tokens' owner
    pub beneficiary: [u8; 32],         // beneficiary owner hash
}
```

`asset` and `amount` are the UTXO's own SPP fields. The owner is `campaign_authority` with the
zero nullifier key, as for the escrow.

### Time windows

| Instruction | Allowed when |
| --- | --- |
| `create` | `now < close_ts < settle_deadline`, `target > 0` |
| `contribute` | `now < close_ts`, status Open, `count < MAX_CONTRIBUTIONS` |
| `settle` | `close_ts <= now < settle_deadline`, status Open, `count >= 1` |
| `refund` | `now >= settle_deadline`, status Open |

Settle and refund windows do not overlap, so payout and refund cannot both succeed.

### Instructions

**`create`** (coordinator signs, pays rent). Initializes the campaign account. No proof.

**`contribute`** (contributor and coordinator sign).
- Program: checks the window, status, capacity and that the coordinator signer matches.
  Verifies the contribute proof against `Poseidon(campaign_authority_owner_hash,
  contributor_identity, campaign_id, beneficiary, private_tx_hash)`, all from the account and
  signer. Reads `outputs[CONTRIBUTION_SLOT].utxo_hash` from the transact and appends it to the
  registry. CPIs SPP signed by `campaign_authority`.
- Circuit: `amount > 0`; the tokens' owner identity equals `contributor_identity`; the asset is
  SOL; a new `DataUtxo<ContributionTerms>` owned by the campaign authority receives `amount`;
  the terms commit `campaign_id`, the tokens' owner and `beneficiary`; the rest is change to
  the contributor. At most 2 token inputs (shape 1x2 or 2x2; see change 6).
- Slot order: as in the escrow, change at slot 0 and the contribution at slot 1; a zero change
  then becomes a zero-amount real output.

**`settle`** (anyone signs as payer; in practice the coordinator).
- Program: checks the window and status, picks `settle_<count>`, verifies against
  `Poseidon(campaign_authority_owner_hash, campaign_id, beneficiary, target, c_0..c_{n-1},
  private_tx_hash)` with the registry entries, sets status Settled, CPIs SPP.
- Circuit (`n` = 1..4): each input is a contribution whose hash equals `c_i`, in registry order;
  its terms match `campaign_id` and `beneficiary`; its owner is the campaign authority; asset
  SOL; the sum is at least `target`; everything moves into one token output owned by the
  beneficiary, after zero-amount beneficiary outputs that fill the SPP shape (change 6).
- Partially filled campaigns use the circuit for their exact count. No data UTXO padding is
  needed. Settling with fewer or other contributions fails the public input check.

**`refund`** (contributor signs).
- Program: checks the window and status, that the public contribution hash is in the registry
  and not yet refunded; marks it refunded; CPIs SPP.
- Circuit: closes one contribution whose hash equals the public `contribution`; terms match
  `campaign_id`; the committed contributor's identity equals the signer's; the whole value
  returns to that contributor.

### Guarantees and where they come from

| Property | Enforced by |
| --- | --- |
| Ownership, inclusion, nullifiers, value conservation, amount range | SPP proof and program |
| Only the program creates or spends contributions | PDA signer: SPP requires the owner's signature for a nonzero data hash and for spends |
| Unsolicited outputs to the PDA never count | They have a zero data hash, are not registered, and no instruction spends them (they are stranded) |
| Exact registered set, no omission or substitution | Settle public inputs carry the registry; circuit compares input hashes |
| No repeated settlement | Status flag, and SPP nullifiers |
| Fixed beneficiary | Campaign account value in the public inputs and in each contribution's terms |
| Refund goes to the donor | Contributor signature plus the committed contributor identity |
| Atomic bookkeeping | One Solana transaction: a failed CPI reverts the registry or status write |

### Private state and availability

- **Contributor:** the contribution output is encrypted to the contributor's viewing key and
  tagged with the campaign authority PDA. After a restart the contributor queries that tag and
  decrypts with `ProgramOwner::decrypt_data_utxos`, which only yields their own. No coordinator
  involvement.
- **Coordinator:** before co-signing, the contributor sends the contribution preimage (terms,
  amount, output blinding, tree). The coordinator recomputes the UTXO hash, compares it with
  `outputs[CONTRIBUTION_SLOT]` of the exact transaction it signs, stores it, then signs. The
  prototype stores preimages in a local JSON file. Losing it means the campaign cannot settle
  and contributors refund: safe, but a liveness failure.
- **Beneficiary:** the settle transaction encrypts the payout to `beneficiary_viewing_pk`.
  No proof enforces that; a wrong key leaves the funds owned by the beneficiary but
  undiscoverable without the coordinator's help.

Optional extension (not planned): an encrypted copy of the preimage for the coordinator in the
transact's `messages`, so the chain backs up the coordinator's store. Unverified in-circuit, so
it only helps when combined with co-signing.

### Privacy

- **Public:** campaign terms (target, deadlines, beneficiary owner hash, coordinator), every
  contributor's Solana pubkey and the number of contributions, which instructions ran, the
  outcome, and that the total is at least the target.
- **Private from observers:** each amount and the total.
- **Known to the coordinator:** every amount. **Known to the beneficiary:** the total.
- **Known to the prover:** the localnet SPP prover server sees each full private transaction.
  Program proofs run in-process (Node) or in the browser. No remote proving is described as
  private.

### Liveness tradeoff

A campaign that reaches its target but is not settled before `settle_deadline` fails and
becomes refundable. Contributions also need the coordinator online and willing to co-sign: no
one can contribute without it, so it can censor contributors or stall a campaign. Funds are
never at the coordinator's mercy: refunds need only the contributor.

## 5. Phase 2 checks: results

1. Output slot binding: relied on, not attacked directly. A replayed contribution reaches the
   registry write and SPP then refuses it, reverting the count; the contribute circuit fixes
   the contribution at slot 1 through its derived blinding.
2. Settle with the coordinator as sender encrypts and proves, and the beneficiary finds its
   payout by its own view tag (localnet, `settle2` and `settle3`).
3. Size and compute: a full four-contribution settlement lands on localnet within the v1
   limits (`full_campaign_settles_four_contributions`). The cap stays at 4.
4. `check_constraints` and `check_private_variables` run on every circuit; settle, contribute and
   refund rejections are tested by rule name.

## 6. Test plan (Phase 3, localnet, proof-carrying transactions)

Implemented as Rust validator tests (`FixtureLocalnet` tests 20, 21 and 22), a TypeScript
lifecycle test and a Chromium test of the web page. The README lists what each verifies:

- Success with 3 contributors; beneficiary balance equals the sum.
- Under target: settle cannot be proven; independent refunds after the deadline.
- Coordinator outage after contributions: deadline passes, contributors restart clients,
  rediscover via the tag query and refund.
- Early settle and early refund rejected; contribute after close and at capacity rejected.
- Wrong campaign, asset, beneficiary, refund owner or registry entry rejected.
- Double refund, settle after settle, refund after success rejected.
- A failing CPI leaves the registry and status unchanged.

## 7. Phase 4 UI

Same approach as the escrow web example: vanilla TypeScript and Vite, disposable localnet
identities in `localStorage` labelled as such, program proofs in a browser worker, SPP proofs
on the local prover. No browser wallet: nothing in the repo shows a wallet signing a v1
transaction. Changed from the plan: one page plays every role, the coordinator included, with
its preimage store in `localStorage`, instead of a separate Node coordinator process. A
coordinator outage is simulated with a toggle. A separate process would add a service without
changing what the prototype demonstrates.

## 8. Decisions

All four recommendations were accepted: the coordinator co-signs, the coordinator creates the
campaign, settlement is permissionless given a valid proof, and the cap is 4 with four settle
circuits.
