//! Native and R1CS checks of the fundraiser circuits, and Groth16 proofs
//! verified through the program's generated verifiers. No validator: the
//! localnet lifecycle is `tests/fundraiser.rs`.

use borsh::BorshDeserialize;
use private_fundraiser_program::{
    circuits::{
        campaign_address, campaign_authority, Contribute, ContributePrivateInputs,
        ContributePublicInputs, ContributionTerms, Refund, RefundPrivateInputs, RefundPublicInputs,
        Settle1, Settle1PrivateInputs, Settle1PublicInputs, Settle2, Settle2PrivateInputs,
        Settle2PublicInputs, Settle4, Settle4PrivateInputs, Settle4PublicInputs,
    },
    instructions::contribute::slot,
    zk::{contribute, refund, settle1, settle2, settle4, Groth16Proof},
};
use solana_address::Address;
use zolana_hasher::primitives::solana_owner_identity;
use zolana_keypair::{ShieldedAddress, ShieldedKeypair};
use zolana_program::{
    circuit::Field,
    compression::PdaOwner,
    testing::{check_private_variables, check_tampered, Tamper},
    CompressedProof, Groth16Prover, Owner, ProgramOwner, TxContext, ZkProgram,
};
use zolana_transaction::{instructions::transact::SppProofInputs, WalletUtxo};

#[allow(dead_code)]
mod shared;
use shared::{keypair, token_input};

const TARGET: u64 = 500;

struct Fixture {
    coordinator: ShieldedKeypair,
    beneficiary: ShieldedAddress,
    campaign: Address,
    authority: ProgramOwner,
    campaign_id: [u8; 32],
}

/// A contribution as the coordinator holds it after co-signing: the spendable
/// UTXO, its terms and the hash the program registered.
struct Accepted {
    utxo: WalletUtxo,
    terms: ContributionTerms,
    hash: [u8; 32],
}

impl Fixture {
    fn new() -> Self {
        let coordinator = keypair(7);
        let campaign = campaign_address(&solana(&coordinator), 1);
        Self {
            beneficiary: keypair(9).shielded_address().expect("beneficiary"),
            authority: campaign_authority(&campaign),
            campaign_id: solana_owner_identity(campaign.as_array()).expect("campaign id"),
            campaign,
            coordinator,
        }
    }

    fn authority_owner_hash(&self) -> [u8; 32] {
        *PdaOwner::new(self.authority.pda())
            .expect("authority")
            .owner_hash()
    }

    fn contribute(
        &self,
        contributor: &ShieldedKeypair,
        amounts: &[u64],
        amount: u64,
    ) -> Contribute {
        Contribute {
            private: ContributePrivateInputs {
                tx_context: TxContext::new(),
                token_utxos: amounts
                    .iter()
                    .enumerate()
                    .map(|(leaf, value)| token_input(contributor, *value, leaf as u64))
                    .collect(),
                amount,
            },
            public: ContributePublicInputs {
                campaign_authority: self
                    .authority
                    .address(contributor.viewing_pubkey())
                    .expect("authority address"),
                contributor_identity: identity(contributor),
                campaign_id: self.campaign_id,
                beneficiary: self.beneficiary.owner_hash().expect("beneficiary hash"),
            },
        }
    }

    fn contribute_public(&self, contributor: &ShieldedKeypair) -> contribute::PublicInputs {
        contribute::PublicInputs {
            campaign_authority: self.authority_owner_hash(),
            contributor_identity: identity(contributor),
            campaign_id: self.campaign_id,
            beneficiary: self.beneficiary.owner_hash().expect("beneficiary hash"),
        }
    }

    /// Proves a contribution, verifies it as the program would and returns
    /// what the coordinator stores.
    fn accept(&self, contributor: &ShieldedKeypair, amount: u64, leaf_index: u64) -> Accepted {
        let inputs = self.contribute(contributor, &[amount + 100], amount);
        let spp = encrypt(&inputs, contributor);
        let prover = Groth16Prover::<Contribute>::new_with_test_setup().expect("setup");
        let proof = prove(&prover, &inputs);
        contribute::verify(
            &groth16(&proof),
            &self.contribute_public(contributor),
            &private_tx_hash(&spp),
        )
        .expect("the program verifier accepts the contribute proof");
        let output = spp
            .output_utxos
            .get(slot::CONTRIBUTION)
            .expect("contribution output");
        let utxo = self
            .authority
            .input(output, spp.output_tree_id, leaf_index)
            .expect("contribution input");
        let terms = ContributionTerms::try_from_slice(output.data.utxo_data().expect("terms"))
            .expect("terms decode");
        Accepted {
            hash: utxo.utxo_hash,
            utxo,
            terms,
        }
    }

    fn settle_public_address(&self) -> ShieldedAddress {
        self.authority
            .address(self.coordinator.viewing_pubkey())
            .expect("authority address")
    }
}

fn solana(keypair: &ShieldedKeypair) -> Address {
    keypair
        .shielded_address()
        .and_then(|address| address.solana_address())
        .expect("solana address")
}

fn identity(keypair: &ShieldedKeypair) -> [u8; 32] {
    solana_owner_identity(solana(keypair).as_array()).expect("identity")
}

fn encrypt<P: ZkProgram>(inputs: &P, keys: &ShieldedKeypair) -> SppProofInputs {
    inputs
        .create_proof_inputs_and_encrypt_with_keys(keys, solana(keys), u64::MAX)
        .expect("proof inputs")
}

fn private_tx_hash(spp: &SppProofInputs) -> [u8; 32] {
    spp.padding_independent_private_tx_hash()
        .expect("private tx hash")
}

fn prove<P: ZkProgram>(prover: &Groth16Prover<P>, inputs: &P) -> CompressedProof {
    let report = check_private_variables(inputs).expect("synthesis");
    assert!(
        report.free.is_empty(),
        "unconstrained private variables: {:?}",
        report.free
    );
    let result = prover.prove(inputs).expect("proof");
    CompressedProof::try_from(&result.proof).expect("compressed proof")
}

/// The settle payout: the last real output, after the zero-amount outputs that
/// fill the SPP shape. Asserts that layout.
fn payout(spp: &SppProofInputs) -> &zolana_transaction::SppProofOutputUtxo {
    let real: Vec<_> = spp
        .output_utxos
        .iter()
        .filter(|output| output.owner_address.is_some())
        .collect();
    let (payout, zeros) = real.split_last().expect("a payout");
    assert!(zeros.iter().all(|zero| zero.amount == 0));
    assert_eq!(spp.output_utxos.len(), real.len(), "no padding outputs");
    payout
}

fn groth16(proof: &CompressedProof) -> Groth16Proof<'_> {
    Groth16Proof {
        a: &proof.a,
        b: &proof.b,
        c: &proof.c,
    }
}

fn broken_rule<P: ZkProgram>(inputs: &P) -> &'static str {
    match inputs.check_constraints() {
        Ok(_) => panic!("the circuit accepted the inputs"),
        Err(error) => error.broken_rule().expect("a named rule"),
    }
}

fn settle2(fixture: &Fixture, accepted: [&Accepted; 2], registry: [[u8; 32]; 2]) -> Settle2 {
    Settle2 {
        private: Settle2PrivateInputs {
            tx_context: TxContext::new(),
            contributions: accepted.map(|a| a.utxo.clone()),
            terms: accepted.map(|a| a.terms.clone()),
        },
        public: Settle2PublicInputs {
            campaign_authority: fixture.settle_public_address(),
            campaign_id: fixture.campaign_id,
            beneficiary: fixture.beneficiary,
            target: TARGET,
            contribution_0: registry[0],
            contribution_1: registry[1],
        },
    }
}

#[test]
fn contribute_binds_campaign_contributor_and_beneficiary() {
    let fixture = Fixture::new();
    let alice = keypair(5);
    let accepted = fixture.accept(&alice, 300, 10);
    assert_eq!(
        accepted.terms,
        ContributionTerms {
            campaign_id: fixture.campaign_id,
            contributor: Owner::try_from(&alice.shielded_address().expect("address"))
                .expect("owner"),
            beneficiary: fixture.beneficiary.owner_hash().expect("beneficiary"),
        }
    );
    assert_eq!(accepted.utxo.utxo.amount, 300);
    assert_eq!(accepted.utxo.utxo.owner, fixture.authority.public_key());
}

#[test]
fn contribute_rejects_bad_inputs() {
    let fixture = Fixture::new();
    let alice = keypair(5);
    let bob = keypair(6);

    let empty = fixture.contribute(&alice, &[100], 0);
    assert_eq!(broken_rule(&empty), "the contribution is empty");

    let mut stolen = fixture.contribute(&alice, &[100], 50);
    stolen.public.contributor_identity = identity(&bob);
    assert_eq!(
        broken_rule(&stolen),
        "the signer does not own the contributed tokens"
    );

    let overdrawn = fixture.contribute(&alice, &[100], 101);
    assert!(overdrawn.check_constraints().is_err());
}

#[test]
fn settle_pays_the_sum_to_the_beneficiary() {
    let fixture = Fixture::new();
    let a = fixture.accept(&keypair(5), 300, 10);
    let b = fixture.accept(&keypair(6), 250, 11);
    let inputs = settle2(&fixture, [&a, &b], [a.hash, b.hash]);
    let spp = encrypt(&inputs, &fixture.coordinator);
    let payout = payout(&spp);
    assert_eq!(payout.amount, 550);
    assert_eq!(
        payout.owner_hash().expect("payout owner"),
        fixture.beneficiary.owner_hash().expect("beneficiary")
    );

    let prover = Groth16Prover::<Settle2>::new_with_test_setup().expect("setup");
    let proof = prove(&prover, &inputs);
    let public = settle2::PublicInputs {
        campaign_authority: fixture.authority_owner_hash(),
        campaign_id: fixture.campaign_id,
        beneficiary: fixture.beneficiary.owner_hash().expect("beneficiary"),
        target: TARGET,
        contribution_0: a.hash,
        contribution_1: b.hash,
    };
    settle2::verify(&groth16(&proof), &public, &private_tx_hash(&spp))
        .expect("the program verifier accepts the settle proof");

    let swapped = settle2::PublicInputs {
        contribution_0: b.hash,
        contribution_1: a.hash,
        ..public
    };
    assert!(
        settle2::verify(&groth16(&proof), &swapped, &private_tx_hash(&spp)).is_err(),
        "a reordered registry must not verify"
    );
    let higher_target = settle2::PublicInputs {
        target: TARGET + 1,
        ..public
    };
    assert!(settle2::verify(&groth16(&proof), &higher_target, &private_tx_hash(&spp)).is_err());

    check_tampered(&inputs, Tamper::PublicHash(Field::from(1u64)))
        .expect_err("a changed public hash must not satisfy the circuit");
}

#[test]
fn settle_rejects_shortfall_substitution_and_wrong_terms() {
    let fixture = Fixture::new();
    let a = fixture.accept(&keypair(5), 300, 10);
    let b = fixture.accept(&keypair(6), 150, 11);
    let c = fixture.accept(&keypair(8), 150, 12);

    let short = settle2(&fixture, [&a, &b], [a.hash, b.hash]);
    assert_eq!(
        broken_rule(&short),
        "the contributions do not reach the target"
    );

    let substituted = settle2(&fixture, [&a, &c], [a.hash, b.hash]);
    assert_eq!(
        broken_rule(&substituted),
        "a spent contribution is not the registered one"
    );

    let mut other_beneficiary = settle2(&fixture, [&a, &c], [a.hash, c.hash]);
    other_beneficiary.public.beneficiary = keypair(10).shielded_address().expect("address");
    assert_eq!(
        broken_rule(&other_beneficiary),
        "a contribution names another beneficiary"
    );

    let mut other_campaign = settle2(&fixture, [&a, &c], [a.hash, c.hash]);
    other_campaign.public.campaign_id = [1u8; 32];
    assert_eq!(
        broken_rule(&other_campaign),
        "a contribution belongs to another campaign"
    );

    let other = Fixture {
        campaign: campaign_address(&solana(&fixture.coordinator), 2),
        ..Fixture::new()
    };
    let mut other_authority = settle2(&fixture, [&a, &c], [a.hash, c.hash]);
    other_authority.public.campaign_authority = campaign_authority(&other.campaign)
        .address(fixture.coordinator.viewing_pubkey())
        .expect("address");
    assert_eq!(
        broken_rule(&other_authority),
        "a contribution is not owned by the campaign authority"
    );
}

#[test]
fn settle_with_one_and_four_contributions() {
    let fixture = Fixture::new();
    let single = fixture.accept(&keypair(5), TARGET, 10);
    let inputs = Settle1 {
        private: Settle1PrivateInputs {
            tx_context: TxContext::new(),
            contributions: [single.utxo.clone()],
            terms: [single.terms.clone()],
        },
        public: Settle1PublicInputs {
            campaign_authority: fixture.settle_public_address(),
            campaign_id: fixture.campaign_id,
            beneficiary: fixture.beneficiary,
            target: TARGET,
            contribution_0: single.hash,
        },
    };
    let spp = encrypt(&inputs, &fixture.coordinator);
    let proof = prove(
        &Groth16Prover::<Settle1>::new_with_test_setup().expect("setup"),
        &inputs,
    );
    settle1::verify(
        &groth16(&proof),
        &settle1::PublicInputs {
            campaign_authority: fixture.authority_owner_hash(),
            campaign_id: fixture.campaign_id,
            beneficiary: fixture.beneficiary.owner_hash().expect("beneficiary"),
            target: TARGET,
            contribution_0: single.hash,
        },
        &private_tx_hash(&spp),
    )
    .expect("settle1 verifies");

    let four: Vec<Accepted> = (0..4)
        .map(|i| fixture.accept(&keypair(20 + i), 125, 10 + u64::from(i)))
        .collect();
    let inputs = Settle4 {
        private: Settle4PrivateInputs {
            tx_context: TxContext::new(),
            contributions: std::array::from_fn(|i| four[i].utxo.clone()),
            terms: std::array::from_fn(|i| four[i].terms.clone()),
        },
        public: Settle4PublicInputs {
            campaign_authority: fixture.settle_public_address(),
            campaign_id: fixture.campaign_id,
            beneficiary: fixture.beneficiary,
            target: TARGET,
            contribution_0: four[0].hash,
            contribution_1: four[1].hash,
            contribution_2: four[2].hash,
            contribution_3: four[3].hash,
        },
    };
    let spp = encrypt(&inputs, &fixture.coordinator);
    assert_eq!(payout(&spp).amount, 500);
    let proof = prove(
        &Groth16Prover::<Settle4>::new_with_test_setup().expect("setup"),
        &inputs,
    );
    settle4::verify(
        &groth16(&proof),
        &settle4::PublicInputs {
            campaign_authority: fixture.authority_owner_hash(),
            campaign_id: fixture.campaign_id,
            beneficiary: fixture.beneficiary.owner_hash().expect("beneficiary"),
            target: TARGET,
            contribution_0: four[0].hash,
            contribution_1: four[1].hash,
            contribution_2: four[2].hash,
            contribution_3: four[3].hash,
        },
        &private_tx_hash(&spp),
    )
    .expect("settle4 verifies");
}

fn refund_inputs(fixture: &Fixture, accepted: &Accepted, signer: &ShieldedKeypair) -> Refund {
    Refund {
        private: RefundPrivateInputs {
            tx_context: TxContext::new(),
            contribution: accepted.utxo.clone(),
            terms: accepted.terms.clone(),
        },
        public: RefundPublicInputs {
            campaign_id: fixture.campaign_id,
            contributor_identity: identity(signer),
            contribution: accepted.hash,
        },
    }
}

#[test]
fn refund_returns_the_whole_contribution_to_its_contributor() {
    let fixture = Fixture::new();
    let alice = keypair(5);
    let accepted = fixture.accept(&alice, 300, 10);
    let inputs = refund_inputs(&fixture, &accepted, &alice);
    let spp = encrypt(&inputs, &alice);
    let payout = spp.output_utxos.first().expect("refund output");
    assert_eq!(payout.amount, 300);
    assert_eq!(
        payout.owner_hash().expect("owner"),
        alice
            .shielded_address()
            .expect("address")
            .owner_hash()
            .expect("hash")
    );
    let proof = prove(
        &Groth16Prover::<Refund>::new_with_test_setup().expect("setup"),
        &inputs,
    );
    refund::verify(
        &groth16(&proof),
        &refund::PublicInputs {
            campaign_id: fixture.campaign_id,
            contributor_identity: identity(&alice),
            contribution: accepted.hash,
        },
        &private_tx_hash(&spp),
    )
    .expect("the program verifier accepts the refund proof");

    assert_eq!(
        broken_rule(&refund_inputs(&fixture, &accepted, &keypair(6))),
        "the signer is not the contributor"
    );
    let mut unregistered = refund_inputs(&fixture, &accepted, &alice);
    unregistered.public.contribution = [2u8; 32];
    assert_eq!(
        broken_rule(&unregistered),
        "the spent contribution is not the registered one"
    );
    let mut other_campaign = refund_inputs(&fixture, &accepted, &alice);
    other_campaign.public.campaign_id = [1u8; 32];
    assert_eq!(
        broken_rule(&other_campaign),
        "the contribution belongs to another campaign"
    );
}
