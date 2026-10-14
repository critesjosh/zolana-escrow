# Private fundraiser on SPP

Date: 2026-10-14
Status: Accepted

## Context

The private fundraiser (`sdk-tests/private-fundraiser`) escrows each contribution as an SPP data
UTXO owned by a campaign PDA, pays them all to a beneficiary when a proof shows they reach the
target, and refunds them otherwise. The DSL, SDK and SPP shaped four choices. The full design is
in [private-fundraiser-design.md](../private-fundraiser-design.md).

## Decision

1. **The coordinator co-signs each contribution** after checking its preimage against the exact
   transaction. An output is encrypted to one viewing key, chosen by the client; it goes to the
   contributor so refunds never need the coordinator.
2. **One settle circuit per contribution count**, `Settle1` to `Settle4`, sharing one generic
   function. The program picks the verifier by the registry count.
3. **The program registers a contribution by reading the transact's output hash** at the
   contribution's slot. SPP binds each real output's hash to its slot through the derived
   blinding.
4. **No padding outputs.** Settle fills its SPP shape with zero-amount outputs to the
   beneficiary, and contribute spends at most two token inputs, because the SDK's empty
   padding outputs carry a zero owner tag that the default-ring circuit rejects.

## Alternatives and tradeoffs

1. Without co-signing, one contributor who withholds or garbles its preimage blocks settlement
   for everyone; with it, the coordinator must be online to accept contributions and can
   censor them. Verifiable encryption to the coordinator would remove both, but the DSL has
   none and adding it is a new primitive.
2. A single padded settle circuit needs dummy data UTXO inputs, which `DataUtxo` refuses. Four
   verifying keys cost program size; a cap below four would cost fewer.
3. Exposing the output hash as a public input needs an SDK change, since output hashes are
   computed after the public inputs.
4. Fixing the SDK padding would be the general fix and let contributions spend more inputs. The
   workaround keeps SDK code unchanged, and costs the beneficiary up to two zero-amount UTXOs
   per settlement.
